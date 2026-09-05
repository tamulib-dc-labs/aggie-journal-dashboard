#!/usr/bin/env python3
"""
Fetch OJS statistics data and save as JSON for a static GitHub Pages dashboard.

Usage:
    python fetch_data.py [--date-start YYYY-MM-DD] [--date-end YYYY-MM-DD]

Reads site configuration from .config/api_keys.yml and fetches:
  - Issues list
  - Submissions list (with status/stage info)
  - Publication stats (view counts per article)
  - Issue stats (view counts per issue)
  - User stats (counts by role)

Output: JSON files in data/ directory
  - data/sites.json — list of all available data snapshots
  - data/<site>.json — all-time data for a site (latest)
  - data/<site>-<label>.json — date-range-specific snapshots
"""
import argparse
import json
import logging
import time
from collections import Counter
from pathlib import Path

import requests
import yaml

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# OJS submission status codes
STATUS_MAP = {1: "Draft", 2: "Queued", 3: "Published", 4: "Declined", 5: "Stalled"}
STAGE_MAP = {1: "Submission", 2: "Review", 3: "Copyediting", 4: "Production", 5: "Published"}

# Stats endpoints run heavy aggregation queries on OJS's side and can be much
# slower than the plain issues/submissions endpoints, especially for large
# journals with an all-time (unfiltered) date range.
DEFAULT_TIMEOUT = 30
STATS_TIMEOUT = 120
MAX_RETRIES = 2
RETRY_BACKOFF_SECONDS = 10


class FetchError(Exception):
    """Raised when an OJS API request ultimately fails after retries.

    Distinct from "the endpoint returned zero items", so callers can avoid
    overwriting a good previous snapshot with an empty one on transient
    failures like read timeouts.
    """


def load_config(config_path):
    """Load site configuration from YAML file."""
    path = Path(config_path)
    if not path.exists():
        logger.error(f"Config file not found: {path}")
        return {}
    with open(path, "r") as f:
        return yaml.safe_load(f) or {}


def ojs_get(base_url, api_key, path, params=None, timeout=DEFAULT_TIMEOUT, retries=MAX_RETRIES):
    """Make authenticated GET request to OJS REST API.

    Retries on timeouts and connection errors (transient/server-load issues),
    but not on HTTP error responses (4xx/5xx), which won't be fixed by retrying.
    """
    url = f"{base_url.rstrip('/')}/api/v1/{path}"
    headers = {"Authorization": f"Bearer {api_key}"}
    attempt = 0
    while True:
        try:
            resp = requests.get(url, headers=headers, params=params, timeout=timeout)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.HTTPError as e:
            logger.error(f"  HTTP error for {path}: {e}")
            return None
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            attempt += 1
            if attempt > retries:
                logger.error(f"  Request error for {path} after {attempt} attempt(s): {e}")
                return None
            wait = RETRY_BACKOFF_SECONDS * attempt
            logger.warning(
                f"  {e.__class__.__name__} for {path} (attempt {attempt}/{retries}), retrying in {wait}s..."
            )
            time.sleep(wait)
        except requests.exceptions.RequestException as e:
            logger.error(f"  Request error for {path}: {e}")
            return None


def fetch_all(base_url, api_key, path, params=None, timeout=DEFAULT_TIMEOUT, retries=MAX_RETRIES):
    """Fetch all items from a paginated OJS endpoint.

    OJS stats endpoints ignore `limit` and return at most 10 items,
    so pagination only works for non-stats endpoints (issues, submissions).

    Raises FetchError if a request ultimately fails after retries — this is
    distinct from an endpoint that legitimately returns zero items.
    """
    all_items = []
    offset = 0
    page_size = 100

    while True:
        p = {"limit": page_size, "offset": offset}
        if params:
            p.update(params)

        data = ojs_get(base_url, api_key, path, params=p, timeout=timeout, retries=retries)
        if data is None:
            raise FetchError(f"Failed to fetch {path} (offset={offset})")

        # Some endpoints (e.g. /stats/users) return a bare array
        if isinstance(data, list):
            return data

        items = data.get("items", []) if isinstance(data, dict) else []
        if not isinstance(items, list):
            items = [items] if items else []
        all_items.extend(items)

        # Stats endpoints return itemsMax; if it's <= page, we've got all
        items_max = data.get("itemsMax", 0) if isinstance(data, dict) else 0
        if "stats/" in path and items_max > 0 and len(all_items) >= items_max:
            break
        if not items or len(items) < page_size:
            break
        offset += page_size

    return all_items


def extract_title(pub):
    """Extract title from publication object."""
    titles = pub.get("fullTitle") or pub.get("title")
    if titles and isinstance(titles, dict):
        return next(iter(titles.values()), "")
    return pub.get("fullTitle", "")


def normalize_publication_stats(items):
    """Normalize publication stats into clean structure."""
    result = []
    for item in items:
        pub = item.get("publication", {})
        total_views = item.get("abstractViews", 0) + item.get("galleyViews", 0)
        result.append({
            "id": pub.get("id"),
            "title": extract_title(pub),
            "authors": pub.get("authorsStringShort", ""),
            "abstract_views": item.get("abstractViews", 0),
            "galley_views": item.get("galleyViews", 0),
            "pdf_views": item.get("pdfViews", 0),
            "html_views": item.get("htmlViews", 0),
            "other_views": item.get("otherViews", 0),
            "total_views": total_views,
            "url_published": pub.get("urlPublished", ""),
            "doi": pub.get("doiObject", {}).get("doi") if pub.get("doiObject") else None,
        })
    return result


def normalize_issue_stats(items):
    """Normalize issue stats into clean structure."""
    result = []
    for item in items:
        issue = item.get("issue", {})
        result.append({
            "id": issue.get("id"),
            "identification": issue.get("identification", ""),
            "volume": issue.get("volume", ""),
            "number": issue.get("number", ""),
            "year": issue.get("year", ""),
            "total_views": item.get("totalViews", 0),
            "toc_views": item.get("tocViews", 0),
            "issue_galley_views": item.get("issueGalleyViews", 0),
            "url": issue.get("publishedUrl", ""),
        })
    return result


def fetch_site_data(name, site, date_start=None, date_end=None):
    """Fetch all data for a single OJS site and return a snapshot dict."""
    api_key = site["key"]
    base_url = site["site"]
    title = site.get("title", name)

    logger.info(f"  Fetching data for '{title}' ({name})...")
    snapshot = {
        "site_name": name,
        "site_title": title,
        "site_url": base_url,
        "date_start": date_start,
        "date_end": date_end,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # Issues
    logger.info("    Issues...")
    issues_raw = fetch_all(base_url, api_key, "issues")
    issues = []
    for i in issues_raw:
        doi_obj = i.get("doiObject") or {}
        issues.append({
            "id": i.get("id"),
            "identification": i.get("identification", ""),
            "volume": i.get("volume", ""),
            "number": i.get("number", ""),
            "year": i.get("year", ""),
            "published": i.get("published", False),
            "published_date": i.get("datePublished"),
            "doi": doi_obj.get("doi") if doi_obj else None,
            "url": i.get("publishedUrl", ""),
            "description": i.get("description", {}).get("en", ""),
        })
    snapshot["issues"] = issues

    # Submissions
    logger.info("    Submissions...")
    submissions_raw = fetch_all(base_url, api_key, "submissions")
    submissions = []
    status_counts = Counter()
    stage_counts = Counter()
    for s in submissions_raw:
        status = s.get("status", 0)
        stage = s.get("stageId", 0)
        status_label = STATUS_MAP.get(status, f"Status {status}")
        stage_label = STAGE_MAP.get(stage, f"Stage {stage}")
        status_counts[status_label] += 1
        stage_counts[stage_label] += 1
        submissions.append({
            "id": s.get("id"),
            "status": status,
            "status_label": status_label,
            "stage_id": stage,
            "stage_label": stage_label,
            "date_submitted": s.get("dateSubmitted"),
            "date_last_activity": s.get("dateLastActivity"),
            "last_modified": s.get("lastModified"),
            "url_published": s.get("urlPublished", ""),
        })
    snapshot["submissions"] = submissions
    snapshot["submission_status_breakdown"] = dict(status_counts)
    snapshot["submission_stage_breakdown"] = dict(stage_counts)

    # Stats params
    stats_params = {}
    if date_start:
        stats_params["dateStart"] = date_start
    if date_end:
        stats_params["dateEnd"] = date_end

    # Publication stats
    logger.info("    Publication stats...")
    pub_stats = normalize_publication_stats(
        fetch_all(base_url, api_key, "stats/publications", params=stats_params or None, timeout=STATS_TIMEOUT)
    )
    snapshot["publication_stats"] = pub_stats

    # Issue stats
    logger.info("    Issue stats...")
    issue_stats = normalize_issue_stats(
        fetch_all(base_url, api_key, "stats/issues", params=stats_params or None, timeout=STATS_TIMEOUT)
    )
    snapshot["issue_stats"] = issue_stats

    # User stats (no date filtering)
    logger.info("    User stats...")
    user_stats = fetch_all(base_url, api_key, "stats/users", timeout=STATS_TIMEOUT)
    snapshot["user_stats"] = user_stats

    # Compute summary — filter issues and submissions by date range
    published_ids = {s["id"] for s in submissions if s["status"] == 3}

    # Date-filtered counts for new content
    if date_start or date_end:
        from datetime import datetime

        def parse_date(date_str):
            if not date_str:
                return None
            try:
                return datetime.strptime(date_str.split(" ")[0], "%Y-%m-%d")
            except (ValueError, AttributeError):
                return None

        ds_dt = parse_date(date_start)
        de_dt = parse_date(date_end)

        # Count issues published in date range
        new_issues_in_period = 0
        for i in issues:
            pub_date = parse_date(i.get("published_date"))
            if pub_date and ds_dt and de_dt:
                if ds_dt <= pub_date <= de_dt:
                    new_issues_in_period += 1
            elif pub_date and ds_dt and not de_dt:
                if pub_date >= ds_dt:
                    new_issues_in_period += 1
            elif pub_date and not ds_dt and de_dt:
                if pub_date <= de_dt:
                    new_issues_in_period += 1

        # Count submissions in date range (submitted within period)
        new_submissions_in_period = 0
        for s in submissions:
            sub_date = parse_date(s.get("date_submitted"))
            if sub_date and ds_dt and de_dt:
                if ds_dt <= sub_date <= de_dt:
                    new_submissions_in_period += 1
            elif sub_date and ds_dt and not de_dt:
                if sub_date >= ds_dt:
                    new_submissions_in_period += 1
            elif sub_date and not ds_dt and de_dt:
                if sub_date <= de_dt:
                    new_submissions_in_period += 1
    else:
        new_issues_in_period = len(issues)
        new_submissions_in_period = len(submissions)
    total_abstract = sum(p["abstract_views"] for p in pub_stats)
    total_galley = sum(p["galley_views"] for p in pub_stats)
    total_pdf = sum(p["pdf_views"] for p in pub_stats)
    total_html = sum(p["html_views"] for p in pub_stats)
    total_other = sum(p["other_views"] for p in pub_stats)
    grand_total = total_abstract + total_galley + total_html + total_other
    total_issue_views = sum(i["total_views"] for i in issue_stats)
    user_total = sum(u.get("value", 0) for u in user_stats if u.get("id") == "total")
    if not user_total:
        user_total = sum(
            u.get("value", 0)
            for u in user_stats
            if isinstance(u.get("id"), int) and u.get("id") > 0
        )

    snapshot["summary"] = {
        "total_issues": len(issues),
        "published_issues": sum(1 for i in issues if i["published"]),
        "unpublished_issues": sum(1 for i in issues if not i["published"]),
        "total_submissions": len(submissions),
        "published_submissions": len(published_ids),
        "new_issues_in_period": new_issues_in_period,
        "new_submissions_in_period": new_submissions_in_period,
        "total_view_count": grand_total,
        "total_abstract_views": total_abstract,
        "total_galley_views": total_galley,
        "total_pdf_views": total_pdf,
        "total_html_views": total_html,
        "total_other_views": total_other,
        "total_issue_views": total_issue_views,
        "total_users": user_total,
    }

    return snapshot


# Standard date ranges for snapshots
def get_standard_ranges():
    """Return list of standard date ranges for snapshot fetching.

    OJS stats API requires dateEnd to be yesterday or earlier
    (returns HTTP 400 with 'lateDateRange' error if it's today).
    """
    today = time.strftime("%Y-%m-%d")
    yesterday = time.strftime("%Y-%m-%d", time.localtime(time.time() - 1 * 86400))
    return [
        {
            "label": "all-time",
            "date_start": None,
            "date_end": None,
        },
        {
            "label": "current-year",
            "date_start": f"{today[:4]}-01-01",
            "date_end": yesterday,
        },
        {
            "label": "previous-year",
            "date_start": f"{int(today[:4])-1}-01-01",
            "date_end": f"{int(today[:4])-1}-12-31",
        },
        {
            "label": "last-90-days",
            "date_start": time.strftime("%Y-%m-%d", time.localtime(time.time() - 90 * 86400)),
            "date_end": yesterday,
        },
        {
            "label": "last-30-days",
            "date_start": time.strftime("%Y-%m-%d", time.localtime(time.time() - 30 * 86400)),
            "date_end": yesterday,
        },
        {
            "label": "last-7-days",
            "date_start": time.strftime("%Y-%m-%d", time.localtime(time.time() - 7 * 86400)),
            "date_end": yesterday,
        },
    ]


def main():
    parser = argparse.ArgumentParser(
        description="Fetch OJS stats data for static dashboard"
    )
    parser.add_argument(
        "--config", "-c",
        default=".config/api_keys.yml",
        help="Path to API keys config file (default: .config/api_keys.yml)",
    )
    parser.add_argument(
        "--outdir", "-o",
        default="data",
        help="Output directory for JSON files (default: data/)",
    )
    parser.add_argument(
        "--date-start",
        default=None,
        help="Start date for stats filtering (YYYY-MM-DD). Use with --date-end for a custom range.",
    )
    parser.add_argument(
        "--date-end",
        default=None,
        help="End date for stats filtering (YYYY-MM-DD). Use with --date-start for a custom range.",
    )
    parser.add_argument(
        "--site", "-s",
        default=None,
        help="Only fetch the named site (key in api_keys.yml) instead of all configured sites.",
    )
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent
    config_path = args.config if args.config.startswith("/") else project_root / args.config
    out_dir = Path(args.outdir) if args.outdir.startswith("/") else project_root / args.outdir

    sites = load_config(config_path)
    if not sites:
        logger.error("No sites configured. Check .config/api_keys.yml")
        return

    if args.site:
        if args.site not in sites:
            logger.error(f"Site '{args.site}' not found in config. Available: {', '.join(sites)}")
            return
        sites = {args.site: sites[args.site]}

    out_dir.mkdir(parents=True, exist_ok=True)
    fetched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ")

    # Determine if we're fetching a custom date range or standard snapshots
    if args.date_start or args.date_end:
        # Custom date range: create/update a labeled snapshot without overwriting sites.json
        ranges = [{
            "label": "custom",
            "date_start": args.date_start,
            "date_end": args.date_end,
        }]
        is_custom = True
    else:
        ranges = get_standard_ranges()
        is_custom = False

    all_site_info = []

    for name, site in sites.items():
        site_dir = out_dir / name
        site_dir.mkdir(parents=True, exist_ok=True)

        snapshot_labels = []
        all_time_data = None
        for r in ranges:
            ds, de = r["date_start"], r["date_end"]
            label = r["label"]
            filename = "snapshot.json" if label == "all-time" else f"{label}.json"
            filepath = site_dir / filename

            logger.info(f"\n[{name}] Snapshot: {label} ({ds or 'start'} to {de or 'end'})")
            try:
                data = fetch_site_data(name, site, ds, de)
            except FetchError as e:
                logger.error(f"  Failed to fetch '{label}' snapshot for '{name}': {e}")
                if filepath.exists():
                    logger.info(f"  Keeping existing snapshot at {filepath}")
                    snapshot_labels.append({
                        "label": label,
                        "file": filename,
                        "date_start": ds,
                        "date_end": de,
                    })
                continue

            if label == "all-time":
                all_time_data = data

            with open(filepath, "w") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            logger.info(f"  Saved to {filepath}")

            snapshot_labels.append({
                "label": label,
                "file": filename,
                "date_start": ds,
                "date_end": de,
            })

        # For non-custom runs, also save the all-time snapshot at the top level
        # (reuses the "all-time" fetch above instead of hitting the API again).
        if not is_custom:
            top_file = out_dir / f"{name}.json"
            if all_time_data is not None:
                with open(top_file, "w") as f:
                    json.dump(all_time_data, f, indent=2, ensure_ascii=False)
                logger.info(f"  Saved all-time snapshot to {top_file}")
            elif top_file.exists():
                logger.info(f"  Keeping existing top-level snapshot at {top_file} (all-time fetch failed)")
            else:
                logger.warning(f"  No all-time data available for '{name}'; top-level snapshot not created")

        # If custom run, preserve existing snapshot labels from sites.json if it exists
        if is_custom:
            existing_index = out_dir / "sites.json"
            if existing_index.exists():
                with open(existing_index, "r") as f:
                    existing = json.load(f)
                for s in existing.get("sites", []):
                    if s["name"] == name:
                        # Merge existing snapshots with the new custom one
                        existing_labels = {snap["label"]: snap for snap in s.get("snapshots", [])}
                        existing_labels["custom"] = snapshot_labels[0]
                        # Put custom at the end for readability
                        ordered = list(existing_labels.values())
                        # Reorder to keep all-time first, custom last
                        ordered.sort(key=lambda x: (x["label"] != "all-time", x["label"] == "custom", x["label"]))
                        snapshot_labels = ordered
                        break
            else:
                # Create an "all-time" snapshot entry so the dropdown isn't empty
                snapshot_labels.insert(0, {
                    "label": "all-time",
                    "file": "snapshot.json",
                    "date_start": None,
                    "date_end": None,
                })

        all_site_info.append({
            "name": name,
            "title": site.get("title", name),
            "directory": name,
            "snapshots": snapshot_labels,
        })

    # Save sites index, merging with any existing entries for sites not fetched this run
    index_path = out_dir / "sites.json"
    if args.site and index_path.exists():
        with open(index_path, "r") as f:
            existing_index = json.load(f)
        other_sites = [s for s in existing_index.get("sites", []) if s["name"] != args.site]
        all_site_info = other_sites + all_site_info

    sites_index = {
        "sites": all_site_info,
        "fetched_at": fetched_at,
    }
    with open(index_path, "w") as f:
        json.dump(sites_index, f, indent=2, ensure_ascii=False)
    logger.info(f"\nDone! Fetched {len(sites)} site(s) to {out_dir}")


if __name__ == "__main__":
    main()

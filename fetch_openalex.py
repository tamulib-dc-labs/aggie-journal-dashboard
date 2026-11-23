#!/usr/bin/env python3
"""
Enrich the dashboard with OpenAlex data, without calling OJS.

Usage:
    python fetch_openalex.py [--site NAME] [--datadir data]

Reads what fetch_data.py already saved in data/<site>.json:
  - `journal.issns`         → finds the journal in OpenAlex (/sources/issn:...)
  - submission/article DOIs → matches individual articles to OpenAlex works

and writes data/openalex/<site>.json with journal-level metrics (works,
citations, h-index, citations by year), per-article citation counts, top
topics / author institutions / countries, and a coverage report (which OJS
DOIs OpenAlex doesn't know about).

If a journal's data file has no `journal` section yet (it was written before
fetch_data.py collected ISSNs), an `issn:` value in .config/api_keys.yml is
used if present.

Environment variables (both optional):
  OPENALEX_API_KEY  — OpenAlex API key; raises the daily request allowance
  OPENALEX_EMAIL    — contact address sent as `mailto`, per OpenAlex etiquette

If anything fails for a journal, its existing OpenAlex file is left as is.
"""
import argparse
import json
import logging
import os
import time
from collections import Counter
from pathlib import Path

import requests
import yaml

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

API = "https://api.openalex.org"
USER_AGENT = "ojs-dashboard (OpenAlex enrichment)"
TIMEOUT = 30
MAX_RETRIES = 3
DOI_BATCH = 50          # OpenAlex allows up to 50 OR-ed values per filter
PER_PAGE = 200          # OpenAlex maximum page size
MAX_WORKS = 10000       # safety cap per journal
TOP_N = 10

SOURCE_FIELDS = ",".join([
    "id", "display_name", "issn_l", "issn", "host_organization_name",
    "homepage_url", "is_oa", "is_in_doaj", "works_count", "cited_by_count",
    "summary_stats", "counts_by_year", "topics",
])
WORK_FIELDS = ",".join([
    "id", "doi", "title", "publication_year", "type", "cited_by_count",
    "open_access", "primary_location", "primary_topic", "authorships",
])


class OpenAlexError(Exception):
    """Raised when an OpenAlex request fails after retries."""


class OpenAlex:
    def __init__(self, api_key=None, email=None):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.base_params = {}
        if api_key:
            self.base_params["api_key"] = api_key
        if email:
            self.base_params["mailto"] = email
        self.calls = 0

    def get(self, path, params=None, allow_404=False):
        p = dict(self.base_params)
        if params:
            p.update(params)
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = self.session.get(f"{API}/{path}", params=p, timeout=TIMEOUT)
                self.calls += 1
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
                if attempt == MAX_RETRIES:
                    raise OpenAlexError(f"{path}: {e}") from e
                time.sleep(5 * attempt)
                continue
            if resp.status_code == 404 and allow_404:
                return None
            if resp.status_code == 429 or resp.status_code >= 500:
                remaining = resp.headers.get("X-RateLimit-Remaining")
                if resp.status_code == 429 and remaining == "0":
                    raise OpenAlexError(
                        "daily OpenAlex limit used up; set OPENALEX_API_KEY or try again tomorrow"
                    )
                if attempt == MAX_RETRIES:
                    raise OpenAlexError(f"{path}: HTTP {resp.status_code}")
                time.sleep(int(resp.headers.get("Retry-After", 5 * attempt)))
                continue
            if not resp.ok:
                raise OpenAlexError(f"{path}: HTTP {resp.status_code} {resp.text[:200]}")
            return resp.json()
        raise OpenAlexError(f"{path}: gave up")

    def list_works(self, filter_, limit=MAX_WORKS):
        """Fetch every work matching `filter_`.

        Uses page-number paging rather than cursors: OpenAlex requires an
        API key for cursor paging, while page paging works without one up to
        10,000 results — far more than any journal here has.
        """
        works, page = [], 1
        while len(works) < limit:
            data = self.get("works", {
                "filter": filter_, "select": WORK_FIELDS,
                "per-page": PER_PAGE, "page": page,
            })
            batch = data.get("results", [])
            works.extend(batch)
            total = data.get("meta", {}).get("count", 0)
            if not batch or len(works) >= total:
                break
            page += 1
        return works[:limit]


def normalize_doi(doi):
    """Lowercase bare DOI (no https://doi.org/ prefix), or None."""
    if not doi:
        return None
    d = str(doi).strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "doi:"):
        if d.startswith(prefix):
            d = d[len(prefix):]
    return d or None


def short_id(openalex_id):
    """https://openalex.org/W123 → W123"""
    return openalex_id.rsplit("/", 1)[-1] if openalex_id else None


def load_ojs_articles(site_data):
    """Map DOI → {ojs_id, title} for published OJS articles that have a DOI."""
    titles = {p["id"]: p.get("title") for p in site_data.get("publication_stats", [])}
    articles = {}
    for s in site_data.get("submissions", []):
        doi = normalize_doi(s.get("doi"))
        if s.get("status") == 3 and doi:
            articles[doi] = {"ojs_id": s["id"], "title": titles.get(s["id"])}
    # Older data files have DOIs only on publication stats, if at all
    for p in site_data.get("publication_stats", []):
        doi = normalize_doi(p.get("doi"))
        if doi and doi not in articles:
            articles[doi] = {"ojs_id": p["id"], "title": p.get("title")}
    return articles


def summarize_work(w, ojs):
    oa = w.get("open_access") or {}
    topic = w.get("primary_topic") or {}
    return {
        "openalex_id": short_id(w.get("id")),
        "doi": normalize_doi(w.get("doi")),
        "ojs_id": ojs.get("ojs_id") if ojs else None,
        "title": w.get("title"),
        "year": w.get("publication_year"),
        "type": w.get("type"),
        "cited_by_count": w.get("cited_by_count", 0),
        "oa_status": oa.get("oa_status"),
        "primary_topic": topic.get("display_name"),
        "field": (topic.get("field") or {}).get("display_name"),
    }


def top_counts(counter, n=TOP_N):
    return [{"name": k, "count": v} for k, v in counter.most_common(n)]


def aggregate(works):
    """Top topics, fields, institutions and countries across a set of works.

    Institutions and countries are counted once per work (not per author),
    so they read as "number of articles with an author from X".
    """
    topics, fields, institutions, countries = Counter(), Counter(), Counter(), Counter()
    for w in works:
        topic = w.get("primary_topic") or {}
        if topic.get("display_name"):
            topics[topic["display_name"]] += 1
        field = (topic.get("field") or {}).get("display_name")
        if field:
            fields[field] += 1
        insts, ctrys = set(), set()
        for a in w.get("authorships") or []:
            for inst in a.get("institutions") or []:
                if inst.get("display_name"):
                    insts.add(inst["display_name"])
            ctrys.update(c for c in (a.get("countries") or []) if c)
        institutions.update(insts)
        countries.update(ctrys)
    return {
        "top_topics": top_counts(topics),
        "top_fields": top_counts(fields),
        "top_institutions": top_counts(institutions),
        "top_countries": top_counts(countries),
    }


def find_source(oa, issns):
    for issn in issns:
        src = oa.get(f"sources/issn:{issn}", {"select": SOURCE_FIELDS}, allow_404=True)
        if src:
            return src
    return None


def fetch_site(oa, name, site_data, config_issns):
    journal = site_data.get("journal") or {}
    issns = journal.get("issns") or config_issns
    ojs_articles = load_ojs_articles(site_data)

    # 1. Journal (source) lookup by ISSN
    source = find_source(oa, issns) if issns else None
    if issns and not source:
        logger.info(f"    Not found in OpenAlex by ISSN {', '.join(issns)}")

    # 2. All works OpenAlex attributes to this journal
    works_by_id = {}
    if source:
        for w in oa.list_works(f"primary_location.source.id:{short_id(source['id'])}"):
            works_by_id[w["id"]] = w

    # 3. OJS DOIs not already covered → look them up directly. Catches
    #    articles OpenAlex has but filed under a different (or no) source.
    found_dois = {normalize_doi(w.get("doi")) for w in works_by_id.values()}
    missing = sorted(d for d in ojs_articles if d not in found_dois)
    for i in range(0, len(missing), DOI_BATCH):
        batch = missing[i:i + DOI_BATCH]
        for w in oa.list_works("doi:" + "|".join(batch)):
            works_by_id.setdefault(w["id"], w)

    works = list(works_by_id.values())
    source_id = source["id"] if source else None
    summaries = []
    for w in works:
        s = summarize_work(w, ojs_articles.get(normalize_doi(w.get("doi"))))
        loc_source = ((w.get("primary_location") or {}).get("source") or {}).get("id")
        s["in_journal_source"] = bool(source_id) and loc_source == source_id
        summaries.append(s)
    summaries.sort(key=lambda s: (-s["cited_by_count"], s["title"] or ""))

    matched = {s["doi"] for s in summaries if s["doi"] in ojs_articles}
    unmatched = [
        {"doi": d, **ojs_articles[d]} for d in sorted(ojs_articles) if d not in matched
    ]

    result = {
        "site_name": name,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "issns": issns,
        "source": None,
        "coverage": {
            "ojs_articles_with_doi": len(ojs_articles),
            "matched_by_doi": len(matched),
            "unmatched_dois": len(unmatched),
            "openalex_works": len(summaries),
            "openalex_works_without_ojs_match": sum(1 for s in summaries if not s["ojs_id"]),
        },
        "totals": {
            "works": len(summaries),
            "cited_by_count": sum(s["cited_by_count"] for s in summaries),
        },
        "counts_by_year": [],
        **aggregate(works),
        "works": summaries,
        "unmatched_articles": unmatched,
    }

    if source:
        stats = source.get("summary_stats") or {}
        result["source"] = {
            "openalex_id": short_id(source["id"]),
            "url": source["id"],
            "display_name": source.get("display_name"),
            "issn_l": source.get("issn_l"),
            "issn": source.get("issn"),
            "host_organization": source.get("host_organization_name"),
            "homepage_url": source.get("homepage_url"),
            "is_oa": source.get("is_oa"),
            "is_in_doaj": source.get("is_in_doaj"),
            "topics": [
                {"name": t.get("display_name"), "count": t.get("count")}
                for t in (source.get("topics") or [])[:TOP_N]
            ],
        }
        # OpenAlex's own journal totals are authoritative over our sum
        result["totals"] = {
            "works": source.get("works_count"),
            "cited_by_count": source.get("cited_by_count"),
            "h_index": stats.get("h_index"),
            "i10_index": stats.get("i10_index"),
            "two_year_mean_citedness": stats.get("2yr_mean_citedness"),
        }
        result["counts_by_year"] = sorted(
            source.get("counts_by_year") or [], key=lambda c: c["year"]
        )
    return result


def load_config_issns(config_path):
    path = Path(config_path)
    if not path.exists():
        return {}
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
    out = {}
    for name, site in cfg.items():
        v = (site or {}).get("issn")
        if v:
            out[name] = v if isinstance(v, list) else [v]
    return out


def main():
    parser = argparse.ArgumentParser(description="Fetch OpenAlex data for the OJS dashboard")
    parser.add_argument("--datadir", "-d", default="data",
                        help="Directory with fetch_data.py output (default: data/)")
    parser.add_argument("--site", "-s", default=None,
                        help="Only fetch the named site")
    parser.add_argument("--config", "-c", default=".config/api_keys.yml",
                        help="Optional config for `issn:` fallbacks (default: .config/api_keys.yml)")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent
    data_dir = Path(args.datadir) if Path(args.datadir).is_absolute() else root / args.datadir
    config_path = Path(args.config) if Path(args.config).is_absolute() else root / args.config
    out_dir = data_dir / "openalex"
    out_dir.mkdir(parents=True, exist_ok=True)

    index_path = data_dir / "sites.json"
    if not index_path.exists():
        logger.error(f"{index_path} not found — run fetch_data.py first")
        return 1
    with open(index_path) as f:
        names = [s["name"] for s in json.load(f).get("sites", [])]
    if args.site:
        if args.site not in names:
            logger.error(f"Site '{args.site}' not in {index_path}. Available: {', '.join(names)}")
            return 1
        names = [args.site]

    config_issns = load_config_issns(config_path)
    oa = OpenAlex(os.environ.get("OPENALEX_API_KEY"), os.environ.get("OPENALEX_EMAIL"))
    failures = 0

    for name in names:
        site_file = data_dir / f"{name}.json"
        if not site_file.exists():
            logger.warning(f"[{name}] no {site_file.name}; skipping")
            continue
        with open(site_file) as f:
            site_data = json.load(f)

        logger.info(f"[{name}] {site_data.get('site_title', name)}")
        try:
            result = fetch_site(oa, name, site_data, config_issns.get(name, []))
        except OpenAlexError as e:
            failures += 1
            logger.error(f"    OpenAlex error: {e} — keeping existing file")
            if "daily OpenAlex limit" in str(e):
                break
            continue

        cov, src = result["coverage"], result["source"]
        logger.info(
            f"    {'source ' + src['openalex_id'] if src else 'no source'}; "
            f"{result['totals']['works']} works, {result['totals']['cited_by_count']} citations; "
            f"DOIs matched {cov['matched_by_doi']}/{cov['ojs_articles_with_doi']}"
        )
        with open(out_dir / f"{name}.json", "w") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)

    logger.info(f"\nDone. {oa.calls} OpenAlex request(s), {failures} failure(s).")
    return 1 if failures and failures == len(names) else 0


if __name__ == "__main__":
    raise SystemExit(main())

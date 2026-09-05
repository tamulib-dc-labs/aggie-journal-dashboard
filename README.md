# OJS Stats Dashboard

A static dashboard for visualizing Open Journal Systems (OJS) statistics across multiple journal sites. Built for GitHub Pages hosting.

## How It Works

1. **`fetch_data.py`** reads `.config/api_keys.yml` and fetches data from the OJS REST API
2. **GitHub Actions** (`.github/workflows/fetch-data.yml`) runs the fetcher monthly and on-demand
3. **Static frontend** (`index.html`, `assets/`) loads JSON data files directly in the browser — no backend required

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Fetch data (saves JSON to data/)
python fetch_data.py

# Serve locally
python -m http.server 8000

# Visit http://localhost:8000
```

Visit `http://localhost:8000` to view the dashboard.

## Configuration

### Site Configuration

Add journal sites to `.config/api_keys.yml`:

```yaml
journal-name:
  key: "your-jwt-api-key"
  site: "https://ojs.example.com/journal-path"
  title: "Journal Display Title"
```

### Fetching Data

```bash
# Fetch standard date-range snapshots (all-time, current year, last 30/90 days, etc.)
python fetch_data.py

# Fetch a custom date range only
python fetch_data.py --date-start 2025-01-01 --date-end 2025-12-31

# Use a custom config file
python fetch_data.py --config /path/to/api_keys.yml

# Output to a specific directory
python fetch_data.py --outdir /path/to/output
```

### Date Filtering

The fetcher creates snapshots for these standard ranges:
- **All Time** — complete stats from journal inception
- **Current Year** — Jan 1 to today
- **Previous Year** — full previous calendar year
- **Last 90 Days** — rolling 90-day window
- **Last 30 Days** — rolling 30-day window
- **Last 7 Days** — rolling 7-day window

You can select any snapshot from the dropdown in the dashboard UI.

> **Note**: The OJS stats API caps results at 10 items. Date filtering narrows which 10 items are returned.

## Project Structure

```
ojs-dashboard/
├── .config/
│   └── api_keys.yml          # Site configuration (API keys, URLs)
├── .github/
│   └── workflows/
│       └── fetch-data.yml    # GitHub Actions (monthly + manual)
├── assets/
│   ├── css/
│   │   └── style.css         # Dashboard styles (dark theme)
│   └── js/
│       └── dashboard.js      # Frontend logic (vanilla JS)
├── data/
│   ├── sites.json            # Index of all sites and snapshots
│   ├── <site>.json           # All-time snapshot per site
│   └── <site>/
│       ├── snapshot.json     # All-time data
│       ├── current-year.json
│       ├── previous-year.json
│       ├── last-90-days.json
│       ├── last-30-days.json
│       └── last-7-days.json
├── index.html                # Main dashboard page
├── fetch_data.py             # Data fetching script
├── requirements.txt          # Python dependencies
└── README.md
```

## GitHub Actions

The workflow triggers on:
- **First day of each month** at 6:00 AM UTC (automatic refresh)
- **Push to main** (automatic refresh)
- **Manual dispatch** via the Actions tab

Manual runs support `--date-start` and `--date-end` inputs for custom date ranges.

### API keys secret

`.config/api_keys.yml` is gitignored and never committed — the workflow instead
recreates it at runtime from a repository secret. To set this up:

1. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**.
2. Name it `OJS_API_KEYS_YML`.
3. Paste the entire contents of your local `.config/api_keys.yml` as the value.

Or from the command line:

```bash
gh secret set OJS_API_KEYS_YML < .config/api_keys.yml
```

The workflow writes this secret back out to `.config/api_keys.yml` on the runner
before calling `fetch_data.py`, so the file only ever exists in the ephemeral
job environment — never in git history.

## License

MIT
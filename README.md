# Jerminal Decline

A satirical analytics dashboard tracking the long-term decline of [TheQuartering](https://www.youtube.com/@TheQuartering)'s YouTube network — views, Shorts-vs-long-form performance, revenue estimates, re-titles, topics and more across **five channels**. Live at [jerminaldecline.com](https://jerminaldecline.com).

There is no backend. Every number on the site is baked into JSON files in `public/` by scheduled jobs and served as static assets, so it costs essentially nothing to run and makes zero API calls per visitor.

## How it works

- Scheduled **GitHub Actions** call the YouTube Data API and regenerate the data files in `public/`, committing the results.
- **Cloudflare** serves the `public/` directory as a static site (config in `wrangler.jsonc`). Each new commit triggers a redeploy within a minute or two.
- The browser loads `public/index.html` — a single self-contained file with all CSS and JS inlined — which `fetch()`es the JSON and renders everything.

YouTube API quota cost is a tiny fraction of the daily free allowance.

## What it tracks

Five channels: **@TheQuartering, @JeremyHambly, @UnSleevedMedia, @rcnightmare, @QuarteringLive**.

- Long-form vs Shorts view/like/comment performance, per channel and network-wide
- Monthly trends, all-time peaks, and "lowest since peak" markers
- Topic tagging (keyword + LLM) and auto-detected **story trackers** for whatever the network is fixated on this week
- A ledger of video **re-titles**
- Catalogued Google Ads campaigns

## Project structure

```
.
├── .github/workflows/      # scheduled jobs (data, audit, topic detection, transcripts)
├── public/                 # the site + all data files (served as-is by Cloudflare)
│   ├── index.html          # the entire dashboard (HTML + CSS + JS in one file)
│   ├── data.json           # master dataset — every video + stats (auto)
│   ├── descriptions.json   # full video descriptions (auto)
│   ├── topic-*.json / .md   # topic taxonomy, tags, trackers, candidates
│   └── ...                 # creator tags, ad campaigns, images, etc.
├── scripts/                # the generators (fetch, tag, detect)
├── wrangler.jsonc          # Cloudflare static-site config
├── serve.ps1               # local dev server
├── MAINTENANCE.md          # operational runbook (what's automated / what's manual)
└── FILES.md                # file-by-file reference
```

> For a description of **every file** — what it is, who writes it, who reads it — see **[FILES.md](FILES.md)**.
> For **how to operate** the pipeline (weekly/monthly tasks, token reminders), see **[MAINTENANCE.md](MAINTENANCE.md)**.

## The data pipeline

**Automated (GitHub Actions):**

| Job | Schedule | Updates |
|---|---|---|
| Update channel data | 4×/day | `data.json`, `descriptions.json`, `title-history.json` (+ a twice-daily snapshot archive) |
| Daily audit | 02:00 UTC | re-checks older videos for deletions / re-titles |
| Detect topic candidates | 04:30 UTC | `topic-candidates.md`, `topic-trackers.json` |

**Manual / local** — transcript fetching runs locally because YouTube blocks GitHub's IP ranges, and the LLM tagging runs locally too:

- Weekly topic refresh — fetches new transcripts, then re-tags videos
- LLM subject tagging and creator-tag extraction
- Occasional taxonomy / label / ad-campaign edits

The exact commands live in [MAINTENANCE.md](MAINTENANCE.md).

## Deploying (first-time setup)

1. **Push to GitHub.** Public or private both work.
2. **Add secrets** under Settings → Secrets and variables → Actions:
   - `YOUTUBE_API_KEY` — required, for the data fetcher
   - `SNAPSHOTS_REPO_TOKEN` — optional, to write the twice-daily snapshot archive
   - `TRANSCRIPTS_REPO_TOKEN` — optional, for transcript fetching
3. **Run the data job once** from the Actions tab ("Update channel data" → Run workflow) to populate `data.json`.
4. **Connect Cloudflare** to the repo. Build command: *none*. Output directory: `public`. Settings are pinned in `wrangler.jsonc`, so production and preview branches build identically.

Every scheduled commit triggers a Cloudflare redeploy automatically.

## Running locally

Preview the site — it must be *served*, not opened from `file://`, because it fetches JSON:

```powershell
./serve.ps1            # serves public/ at http://localhost:8000
```

Regenerate the data (needs a YouTube API key in your environment):

```powershell
$env:YOUTUBE_API_KEY = "AIza..."
node scripts/fetch-data.js
```

## Customising

All in `scripts/fetch-data.js`:

- **Channels:** edit the `CHANNELS` array
- **Shorts cutoff:** `SHORTS_CUTOFF_SEC` (default 180s = 3 min)
- **History depth on first run / backfill:** `HISTORY_YEARS`
- **Schedule:** the cron expressions in `.github/workflows/update-data.yml`

## Cost

GitHub Actions, Cloudflare Pages/Workers, and the YouTube API are all free at this scale. The only optional cost is a custom domain (~£10/year).

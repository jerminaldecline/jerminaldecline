# File guide

A plain-English map of every file in this repo: what it is, who writes it, who reads it, and how often it changes. If you're trying to remember "what is `topic-trackers.json` again?" or "which script makes this file?", start here.

For *how to run the maintenance tasks*, see [MAINTENANCE.md](MAINTENANCE.md). This file is about *what each thing is*.

---

## The 30-second mental model

It's a **static website with no backend**. Everything the site shows is baked into JSON files that get regenerated on a schedule and committed to git. Cloudflare serves the `public/` folder as-is. The browser does all the work by reading those JSON files.

So the repo is really three things:
1. **One big HTML file** (`public/index.html`) — the entire dashboard.
2. **A pile of JSON data files** in `public/` — what the dashboard reads.
3. **Scripts + GitHub Actions** that regenerate the JSON on a schedule.

```
                          YouTube Data API
                                 │
                    ┌────────────┴─────────────┐
                    │     scripts/fetch-data.js │  (4×/day, automated)
                    └────────────┬─────────────┘
                                 ▼
        public/data.json  ·  descriptions.json  ·  title-history.json
         (video stats)       (full descriptions)   (re-title ledger)
                                 │
        ┌────────────────────────┼───────────────────────────┐
        ▼                        ▼                            ▼
 detect-topic-           fetch-transcripts.js          (local taggers)
 candidates.js           → transcripts repo            tag-topics.js → topic-tags.json
 → topic-candidates.md   (manual/local)               LLM tagger    → topic-tags-llm.json
 → topic-trackers.json                                creator tags  → creator-tags.json
        │                                                     │
        └─────────────────────────┬───────────────────────────┘
                                  ▼
                        public/index.html
                   (browser reads all the JSON →
                      renders the dashboard)
```

There are also **two sister repos** (separate from this one): `jerminaldecline-transcripts` (one transcript per video) and `jerminaldecline-snapshots` (a gzipped copy of `data.json` saved twice a day).

---

## Root files

| File | What it is |
|------|------------|
| **README.md** | The *original* first-time setup / deploy guide (GitHub secret, Cloudflare Pages, etc.). ⚠️ Written when the project tracked a single channel — it's now 5 channels with many more moving parts, so treat it as historical. **MAINTENANCE.md is the current source of truth.** |
| **MAINTENANCE.md** | The live runbook: what's automated, what you do by hand (weekly topic refresh, monthly ad review), token-expiry reminders, and a full file map. Read this before touching the pipeline. |
| **FILES.md** | This file. |
| **serve.ps1** | Local dev server. `./serve.ps1` serves `public/` on `localhost:8000` (uses Python's `http.server`, falls back to `npx serve`). Needed because the site fetches JSON, which doesn't work from `file://`. |
| **wrangler.jsonc** | Cloudflare config. Tells Cloudflare "this is a static site, serve the `./public` directory, no build step." Committed so production and preview branches build identically. |
| **.gitignore** | Standard ignores (`node_modules`, `.env`, logs). |
| **.gitattributes** | Forces LF line endings in the repo so Windows/Linux edits don't create phantom diffs. |

---

## The site

| File | What it is |
|------|------------|
| **public/index.html** | **The entire dashboard** — ~9,500 lines with all CSS and JavaScript inlined. No build step, no framework. On load it `fetch()`es the JSON files below and renders the Overview / Analysis / Videos tabs, charts, topic explorers, etc. |
| **public/logo.png**, **favicon.ico**, **favicon-32.png**, **apple-touch-icon.png** | Branding and tab/bookmark icons. |
| **public/party-mascots.gif**, **unconscious_jer.png** | Easter-egg art for the "party mode" / "funeral mode" toggles in the UI. |

---

## Core data (the foundation everything else builds on)

| File | Written by | Read by | Cadence | What it is |
|------|-----------|---------|---------|------------|
| **public/data.json** | `fetch-data.js` | the site + every script | 4×/day (auto) | The master dataset. Every video across all 5 channels with `views`, `likes`, `comments`, `durationSec`, `isShort`, `publishedAt`. Also per-channel `snapshots[]` (daily total channel views + sub count) and `meta` counts. **~5 MB.** |
| **public/descriptions.json** | `fetch-data.js` | site + taggers + detector | 4×/day (auto) | Full text of every video description, kept in its own file so `data.json` stays lean. Shape: `{ lastUpdated, descriptions: { videoId: "..." } }`. **~4.5 MB.** |
| **public/title-history.json** | `fetch-data.js` | the site | 4×/day (auto) | A ledger of every video title change we've observed: `{ first, current, changes:[{from,to,at,via}] }`. This is how the site shows TheQuartering's habit of re-titling videos. Currently ~25 re-titles tracked. |

---

## Topics & tagging (the part with the most files)

There are **three independent "tagging" systems**, which is the usual source of confusion. Here's the difference:

| System | File | How it decides | Coverage |
|--------|------|----------------|----------|
| **Creator tags** | `creator-tags.json` | Just *copies* the tags the creator typed into YouTube (incl. YouTube's auto-tags). No analysis. | ~every video |
| **Topic tags** (keyword) | `topic-tags.json` | `tag-topics.js` scores title/description/**transcript** against keyword lists and assigns one primary topic if the score clears a threshold. | only videos that match — heavily reliant on transcripts |
| **Subject tags** (LLM) | `topic-tags-llm.json` | A local Claude (Haiku) tagger reads each video and classifies its *subject*, *theme*, and *format*. | most videos, incl. an AI one-line summary each |

> Why does a new video get a creator tag instantly but not a topic tag? Because creator tags are *copied* from metadata, while topic tags need the **transcript** — and transcripts are fetched separately and lag a day or two behind upload. See MAINTENANCE.md.

| File | Written by | Read by | Cadence | What it is |
|------|-----------|---------|---------|------------|
| **public/topics.json** | local (LLM taxonomy build) + hand edits | `tag-topics.js`, the site | manual | The topic **taxonomy**: every subject/theme/format with a display `name`, `color`, `kind`, and (for keyword-taggable ones) a `keywords` list. The shared vocabulary both taggers map videos into. |
| **public/topic-tags.json** | `tag-topics.js` (local, weekly) | the site | weekly (manual) | Keyword tagger output: `{ tags: { videoId: topicId }, _stats }`. One primary topic per video. |
| **public/topic-tags-llm.json** | local LLM tagger | the site | as run (local) | LLM tagger output: per-video subject/theme/format + `_confidence`, `_subjectRaw`, `_summary` (AI one-liner), and `_promoted*` lists of subjects/themes big enough to surface. Model + taxonomy hash recorded in the header. |
| **public/topic-tag-overrides.json** | hand-edited | `tag-topics.js` | as needed | Manual escape hatch: pin a video to a specific topic, or `null` to force-untag a false positive. Applied *after* keyword scoring. Used when TQ's euphemisms dodge the keyword scorer. |
| **public/creator-tags.json** | local (metadata extractor) | the site | as run (local) | The creator's own YouTube tags per video: `{ videoId: { tags:[...], fetchedAt } }`. Powers the "Video tags" explorer. |

### Story trackers (the "what's TQ obsessed with this week" feature)

| File | Written by | Read by | Cadence | What it is |
|------|-----------|---------|---------|------------|
| **public/topic-candidates.md** | `detect-topic-candidates.js` | **a human** | nightly (auto) | A readable report of term clusters that *spiked* in the last 7 days vs the 60-day baseline. You skim it monthly to decide if a new story arc deserves a curated label. |
| **public/topic-trackers.json** | `detect-topic-candidates.js` | the site | nightly (auto) | The machine-readable companion: clusters hot enough (>30% saturation) to show as live "story trackers" on the site. No code change needed when a new story spikes. |
| **public/topic-labels.json** | hand-edited | the site | as needed | Friendly-name + keyword overrides for the auto-detected trackers (e.g. force the detector's `"trial"` cluster to display as `"Karmelo Anthony"`). |

---

## Other data

| File | Written by | Cadence | What it is |
|------|-----------|---------|------------|
| **public/ad-videos.json** | hand-edited | monthly-ish | Catalogue of confirmed Google Ads campaigns pointing at tracked videos (from the Marketing Sheriff advertiser page). Powers the "promoted videos" callout. `{ meta, channels }`. |

---

## Scripts (`scripts/`)

| File | Run by | What it does |
|------|--------|--------------|
| **fetch-data.js** | `update-data.yml` (4×/day) & `daily-audit.yml` | The fetcher. Calls the YouTube API, pulls recent uploads + view stats for all 5 channels, merges into `data.json`, and writes `descriptions.json` + `title-history.json`. Modes: default (last 60 days), `--backfill` (whole history), `--audit` (re-check old videos for deletions/re-titles). |
| **fetch-transcripts.js** | local / dormant workflows | Pulls YouTube auto-caption transcripts and stores them in the **transcripts sister repo** (one JSON per video + an `index.json` of fetched/failed status). Modes: `--backfill`, `--incremental`, `--retry-failures`. Run locally because YouTube blocks GitHub's IPs. Commits in batches of 100 so it's resumable. |
| **tag-topics.js** | `refresh-topics.ps1` (local, weekly) | The **keyword topic tagger**. Scores each long-form video's title (×3) + description (×1.5) + transcript (×1) against `topics.json` keywords; assigns the best-scoring topic if it clears a threshold. Writes `topic-tags.json`. |
| **detect-topic-candidates.js** | `detect-topic-candidates.yml` (nightly) | The **story detector**. Finds terms spiking in recent descriptions, clusters them by which videos they co-occur in, and writes the human report (`topic-candidates.md`) + the live trackers (`topic-trackers.json`). |

> Two taggers are **not** in this repo: the LLM subject tagger (writes `topic-tags-llm.json`) and the creator-tag extractor (writes `creator-tags.json`). They run locally and just commit their output here.

---

## GitHub Actions (`.github/workflows/`)

| Workflow | Schedule | What it runs |
|----------|----------|--------------|
| **update-data.yml** | 4×/day (00:07, 03:17, 13:37, 19:47 UTC) | `fetch-data.js`, commits data. Also gzips `data.json` into the **snapshots sister repo** once per AM and once per PM half. |
| **daily-audit.yml** | 02:00 UTC daily | `fetch-data.js --audit` — re-checks older videos for deletions and re-titles outside the 60-day window. |
| **detect-topic-candidates.yml** | 04:30 UTC daily | `detect-topic-candidates.js`, commits the candidate report + trackers. |
| **fetch-transcripts.yml** | **dormant** (cron commented out) | Incremental transcript fetch. Disabled because YouTube blocks GitHub IPs — run locally instead. Kept for if that ever changes. |
| **backfill-transcripts.yml** | **manual only** | One-off full transcript backfill / failure retry. Already ran. |

---

## Sister repos (separate repositories, not in this one)

| Repo | What it holds |
|------|---------------|
| **jerminaldecline-transcripts** (private) | One `transcripts/<videoId>.json` per video (full caption segments) + `index.json` tracking fetched/failed status. Written by `fetch-transcripts.js`. The keyword tagger reads these. |
| **jerminaldecline-snapshots** (public) | A gzipped copy of `data.json` saved **twice a day** (`YYYY-MM-DD-AM/PM.json.gz`). A historical archive — the only place with a true per-video time series, since `data.json` itself only ever holds the latest values. |

---

## Quick "who writes this file?" lookup

- **Automated, 4×/day:** `data.json`, `descriptions.json`, `title-history.json` (+ snapshots repo)
- **Automated, nightly:** `topic-candidates.md`, `topic-trackers.json`
- **Local, weekly:** `topic-tags.json` (via `refresh-topics.ps1`, which also fetches transcripts)
- **Local, as run:** `topic-tags-llm.json`, `creator-tags.json`
- **Hand-edited, as needed:** `topics.json`, `topic-labels.json`, `topic-tag-overrides.json`, `ad-videos.json`, `index.html`

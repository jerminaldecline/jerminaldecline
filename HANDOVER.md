# jerminaldecline — end-to-end handover

Written 2026-08-18. Read this first if you are picking the project up cold.

Everything below was verified against the code, the workflow files, the Windows
scheduled tasks and the live repos on that date — **not** copied from the older
docs, several of which are wrong (see [Doc status](#8-doc-status) at the bottom).

---

## 1. What it is

A satirical analytics dashboard tracking TheQuartering (Jeremy Hambly)'s YouTube
network. Live at **jerminaldecline.com**. Six channels, ~15,970 videos.

There is **no backend and no build step**. Every number is baked into JSON at
generation time and served as a static asset. The browser fetches the JSON and
does all the work. **Git is the deployment mechanism**: a commit to `main`
triggers a Cloudflare redeploy in about a minute.

Channels tracked (`scripts/fetch-data.js:41`) — note it is **six**, not five as
README says:

    @TheQuartering   @JeremyHambly    @UnSleevedMedia
    @rcnightmare     @QuarteringLive  @QuarteringVlogs

---

## 2. Where everything lives

### Repos (GitHub org: `jerminaldecline`)

| Repo | Local path | Role |
|---|---|---|
| `jerminaldecline` | `d:\Personal\Code Repos\jerminaldecline` | **The working clone.** Site, scripts, all data. |
| `jerminaldecline-snapshots` | `d:\Personal\Code Repos\jerminaldecline-snapshots` | Public. The **only** per-video time series. 133 snapshots + 156 debut samples. |
| `jerminaldecline-transcripts` | `d:\Personal\Code Repos\jerminaldecline-transcripts` | Private. 15,183 transcripts + `index.json` status map. |

### Not in git — and this matters

| Thing | Path | Why it matters |
|---|---|---|
| **Local runner** | `C:\Users\bradw\OneDrive\Desktop\Project FIles\Transcripts\transcript-runner` | Runs LLM tagging, transcripts, creator tags. **No version control.** Contains `_canon-fix/` (the tagger entity-split fix). |
| **Second clone** | `C:\Users\bradw\OneDrive\Desktop\Project FIles\jerminaldecline` | The runner's push target (`JD_MAIN_REPO` default). Sits on `main`. |
| **`CLAUDE.md`** | repo root | Accurate, and **untracked** — exists only on this machine. |

### Scheduled tasks (Windows Task Scheduler, local machine)

| Task | When | Runs |
|---|---|---|
| `JerminalDecline-AdScrape` | daily 11:00 local | `scripts\run-scrape-ads.cmd` → `scrape-ads.py --apply --commit` |
| `jerminaldecline refresh` | **Tue + Fri 09:00** | `refresh-topics-llm.ps1` (LLM tagging) |

Ad-scrape log: `%LOCALAPPDATA%\jerminaldecline\scrape-ads.log`.
Runner logs: `<runner>\logs\`, status in `<runner>\refresh-status.json`.

Both tasks need the **PC on and logged in**. Neither runs in CI.

### Hosting

Cloudflare **Workers static assets** (not Pages). Config is `wrangler.jsonc`,
committed so production and preview branches build identically:

    "assets": { "directory": "./public" }

No Worker script — Cloudflare serves `./public` directly.

> **Verify deploys against `https://jerminaldecline.com/`, never
> `/index.html`.** They are separate cache objects; the `/index.html` form goes
> stale and a `?cb=` query string does not bust it.

---

## 3. Branch discipline — enforced in code

- **UI changes** (`public/index.html`) → `staging`, then promoted.
- **Data-only changes** → straight to `main`.
- Promotion is **not a merge**. `scripts/promote-to-live.sh` copies staging's
  `index.html` wholesale onto main, because staging deliberately lags main on
  scripts and data. `git log main..staging` shows ~180 commits — the branches
  never merge, so ancestry means nothing here. Verify by **content**.
- `scripts/hooks/pre-commit` blocks `public/index.html` on `main` unless
  `JD_PROMOTE=1`, and blocks files carrying a `"_TESTDATA":` key.

**The hook is wired per-clone and does not travel with the repo:**

    git config core.hooksPath scripts/hooks

Run that in any new clone or it starts unprotected.

> ⚠️ **Leave the working clone on `main` when you finish.** The daily ad scrape
> aborts if the repo is on another branch — see
> [Traps](#7-traps-that-have-actually-bitten).

---

## 4. The pipelines, end to end

### 4a. Core channel data — hourly, CI

    YouTube Data API v3 (key auth)
        → scripts/fetch-data.js
        → public/data.json, descriptions.json, title-history.json
        → commit to main → Cloudflare redeploy

`.github/workflows/update-data.yml`, cron `7 * * * *`. The same job also runs
`resolve-removed-reasons.js` (best-effort).

`daily-audit.yml` runs `fetch-data.js --audit` at **02:00 and 14:00** — re-checks
older videos for deletions and re-titles.

All three main-committing workflows share `concurrency: main-data-push`, because
delayed crons bunch up and race each other on `meta.lastUpdated`.

**Quota:** `search.list` costs 100 units, everything else 1. The site runs
~1,450 units/day against a 10,000 allowance.

### 4b. Snapshots + debut samples — the time series

`data.json` is **current-state only**. All history lives in the snapshots repo.

Inside the same hourly job (best-effort, `continue-on-error`):

- **Twice-daily full dump** → `snapshots/YYYY-MM-DD-{AM,PM}.json.gz`, idempotent
  per half. Runs *first* — it is the irreplaceable artefact, so nothing optional
  is allowed to run ahead of it and risk aborting the step.
- **Hourly debut sample** → `debut/`, via `sample-debut.js`. Nearly all of a
  video's views arrive on day one, which twice-daily snapshots cannot resolve.
  The hourly run already fetched the view counts, so this costs no extra quota —
  it just stops discarding 22 of the 24 daily readings.

A **staleness tripwire** at the end of the job is deliberately *not*
best-effort: if the snapshots repo has not committed in 36h it fails the run red.
Without it, a dead token would keep every run green while the archive silently
stopped growing — taking view-velocity, the ad ledger and historic views with it.

### 4c. Derived analytics — hourly, CI, from the snapshot archive

Same workflow, after the snapshot step, reusing the clone it already made:

| Script | Output |
|---|---|
| `build-view-velocity.py` | `view-velocity.json` |
| `build-ad-ledger.py` | `ad-ledger.json` |
| `build-historic-views.py` | `historic-views.json` |
| `build-daily-views.js` | `daily-views.json` |

### 4d. Ads — daily, LOCAL, not CI

    Google Ads Transparency Centre
    (advertiser AR13693796838614761473, "Marketing Sheriff")
        → scrape-ads.py  (Playwright headless Chromium, SearchCreatives API)
        → ad-campaigns.json, ad-videos.json, ad-yield.json, view-spikes.json
        → git commit + push to main

Local because it needs a residential IP and a real browser — the Centre is a JS
SPA, so a plain HTTP fetch returns an empty shell.

A video earns a badge when the Centre holds a dated **creative** for it, not
merely because a thumbnail request went past.

- The Centre retains only ~10 months of creatives, so catalogued videos are
  **never removed** for lack of one. Absence is meaningful only for videos newer
  than the retention edge (`ad-campaigns.json` → `trackingFrom`).
- `--min-ads N` (default 50) aborts without writing if the harvest comes back
  short — guards against a bot-block or a payload shape change.
- Creatives cached as `null` **are retried** every run. They used to be treated
  as final, which permanently blacklisted them and silently suppressed a live ad.

### 4e. Removed-video reasons

`fetch-data.js` only learns that a video is *gone*; the reason comes from
scraping the watch page. `resolve-removed-reasons.js` fills that in,
incrementally, so the usual hourly cost is zero requests.

It is on the **hourly** job specifically because the strike banner keys off the
reason code, not the unavailable flag — until a removal is classified, a
Community Guidelines strike is indistinguishable from a video the uploader made
private, and the banner cannot fire.

### 4f. Topics / LLM tagging — Tue+Fri, LOCAL runner

    refresh-topics-llm.ps1
      1. sync data.json + descriptions + topics + overrides from main
      2. fetch new transcripts (local only — YouTube blocks CI IPs)
      3. tag NEW videos only, canon ON
      4. detect newly-promoted subjects (entity-split early warning)
      5. copy to the SECOND CLONE, commit + push to main
      6. write refresh-status.json for the dashboard

Needs `ANTHROPIC_API_KEY`, `TRANSCRIPTS_REPO_TOKEN`, `TRANSCRIPTS_REPO`.
A lockfile prevents overlap. `-NoPush` stops before pushing, for manual review.

**Canon must stay ON.** With it off the tagger splits entities. There is a
separate known failure where it flattens specific subjects into categories — fix
and backup live in `<runner>\_canon-fix\`. The tagger is non-deterministic, so
re-running can change the output.

The site reads `topic-tags-llm.json`. `topic-tags.json` is **legacy and no
longer refreshed**.

### 4g. Creator tags — manual, local

`fetch-creator-tags.py` (plain HTTP with a consent cookie — ~10–20× faster than
the old Playwright version, and resumable) writes `creator-tags.json` in the
runner. `deploy-creator-tags.ps1` copies it into the repo **on `staging`** and
commits.

### 4h. Transcripts — local, sister repo

`fetch-transcripts.js` writes one file per video to the transcripts repo, plus an
`index.json` status map. The CI workflows `fetch-transcripts.yml` (schedule
commented out) and `backfill-transcripts.yml` (manual, already run) are
**dormant** — YouTube blocks GitHub Actions IP ranges. Leave them alone.

### 4i. Reposts

`reposts.json` records his Shorts traced back to an original source — via a
surviving platform watermark, community credit in the comments, or manual
tracing. Produced out of the `content-theft-tracker` project
(`d:\Personal\Code Repos\content-theft-tracker`), which is **not under version
control**.

Note `creator` is the account the clip was taken *from*: a watermark proves
provenance to that account, not that the account filmed it — some watermarked
accounts are themselves repost aggregators.

### 4j. Parked — view-count change measurement

`public/view-count-change.json` and the two `measure-*.js` scripts live **only on
`staging`**, together with the notice UI in `index.html`.

From 24 Aug 2026 YouTube counts a view from the first frame with no minimum watch
time; long-form previously needed ~30s. Shorts already worked this way since
31 Mar 2025, which is why they serve as the control group.

The old metric is gone for good from the public Data API — it survives only as
"Engaged Views" in the Analytics API, which requires channel-owner OAuth. So the
before/after measurement is the only way to bridge the join.

Parked deliberately until real post-change data exists. Achievable accuracy and
method notes are in that JSON file's `_precision`, `_method` and `_method2` keys.

---

## 5. File → producer map

| File | Written by | When |
|---|---|---|
| `data.json`, `descriptions.json`, `title-history.json` | `fetch-data.js` | hourly CI |
| `removed-reasons.json` | `resolve-removed-reasons.js` | hourly CI |
| `view-velocity.json` | `build-view-velocity.py` | hourly CI |
| `ad-ledger.json` | `build-ad-ledger.py` | hourly CI |
| `historic-views.json` | `build-historic-views.py` | hourly CI |
| `daily-views.json` | `build-daily-views.js` | hourly CI |
| `topic-candidates.md`, `topic-trackers.json` | `detect-topic-candidates.js` | nightly CI 04:30 |
| `ad-campaigns.json`, `ad-videos.json`, `ad-yield.json`, `view-spikes.json` | `scrape-ads.py` | daily local 11:00 |
| `topic-tags-llm.json`, `topics.json` | LLM runner | Tue+Fri local |
| `creator-tags.json` | `fetch-creator-tags.py` + deploy script | manual local |
| `reposts.json` | content-theft-tracker | manual |
| `topic-labels.json`, `topic-tag-overrides.json` | **hand-edited** | as needed |
| `topic-tags.json` | — | **LEGACY, dead** |
| `index.html` | you, on `staging` | manual |

---

## 6. Secrets and expiries

GitHub Actions secrets: `YOUTUBE_API_KEY`, `SNAPSHOTS_REPO_TOKEN`,
`TRANSCRIPTS_REPO_TOKEN`.
Local env vars: `ANTHROPIC_API_KEY`, `TRANSCRIPTS_REPO_TOKEN`, `TRANSCRIPTS_REPO`.

**Both repo tokens expire early October 2026** — TRANSCRIPTS 2026-10-06,
SNAPSHOTS ~2026-10-05. Rotate them together.

> MAINTENANCE.md says "~September 2026" and "~June 2027". Those are stale; the
> October dates above were checked more recently.

Their failure modes differ, so check them differently:

- **TRANSCRIPTS** is load-bearing and currently working. Verify against a
  token-authed origin, **not** the local sibling clone, which goes stale and will
  lie to you.
- **SNAPSHOTS** dying leaves CI **green**. That is exactly what the 36h staleness
  tripwire exists to catch. Confirm by checking the snapshots repo's own commits.

---

## 7. Traps that have actually bitten

**Leaving the working clone on a non-`main` branch silently kills the ad scan.**
`scrape-ads.py` refuses to commit unless the repo is on `main`. It still scrapes
and writes correct data locally — it just never pushes, and exits 3. This
happened on 2026-08-18 after UI work left the clone on `staging`. Making the
scraper branch-independent (read `data.json` from `origin/main`, commit via a
worktree) is a known open improvement.

**Blank page with no console error.** A `const` referenced above its declaration
throws a ReferenceError inside `loadAndCompute()`, which `init()`'s try/catch
swallows. The page renders empty and the console stays clean. A dead local dev
server produces an identical symptom — check the server is actually up first.

**CSS edits that "do nothing".** A malformed comment can swallow the rules that
follow it. Parse the stylesheet (`document.styleSheets`) rather than grepping —
and beware that a visual test can pass because the design is *gone*, not because
it is correct.

**`git log main..staging` is meaningless.** The branches never merge, so it shows
~180 commits regardless. Compare file content, not ancestry.

**The snapshot archive starts 11 June 2026.** Any "all time" claim derived from
the time series is bounded by that date, not by channel age.

**yt-dlp in content-theft-tracker** needs a `js_runtime` configured or roughly
half of all downloads fail silently — exit 0, no media file. That fix and a
format-selector fix both exist **only on disk, untracked**.

---

## 8. Doc status

| Doc | Trust |
|---|---|
| **This file** | Verified 2026-08-18. |
| `CLAUDE.md` | Accurate. **Untracked — back it up.** |
| `MAINTENANCE.md` | Useful runbook, but schedules and token dates are stale. |
| `FILES.md` | Mostly right; says 5×/day, lists dead cron times, corrupted table ~L106. |
| `README.md` | **Historical and disowned.** Says five channels and 4×/day. |

Claims still in the older docs that are wrong: 4–5× daily updates (it is hourly),
five channels (six), `daily-audit` running daily (twice daily), and
`topic-tags.json` being live (legacy — the site reads `topic-tags-llm.json`).

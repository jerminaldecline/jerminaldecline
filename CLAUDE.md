# jerminaldecline

Satirical analytics dashboard tracking TheQuartering (Jeremy Hambly)'s YouTube network.
Live at jerminaldecline.com. Remote: github.com/jerminaldecline/jerminaldecline.

## Architecture

No backend, no per-visitor API calls. All data is baked into JSON at build time and
served as static assets. **Git is the deployment mechanism** — bots commit regenerated
JSON to `main`, Cloudflare Workers static assets redeploys in ~1 minute. No build step.

```
YouTube Data API v3 ──→ scripts/fetch-data.js ──→ public/data.json, descriptions.json,
                                                  title-history.json
watch-page HTML     ──→ resolve-removed-reasons.js ──→ removed-reasons.json
                    ↓ hourly gzip
        jerminaldecline-snapshots  (the ONLY per-video time series; data.json is current-only)
                    ↓
   build-view-velocity.py / build-ad-ledger.py / build-historic-views.py / build-daily-views.js
                    ↓
Ads Transparency Center (Playwright) ──→ scrape-ads.py ──→ detect-spikes.js,
                                                           measure-campaign-yield.js
                    ↓
        public/index.html (~9,500 lines, all CSS+JS inlined) fetch()es every JSON above
```

## Facts that the docs get wrong

- **Six channels are tracked**, not five. See `scripts/fetch-data.js:41`:
  `@TheQuartering, @JeremyHambly, @UnSleevedMedia, @rcnightmare, @QuarteringLive, @QuarteringVlogs`.
- **`update-data.yml` runs hourly** (`cron: '7 * * * *'`), changed 2026-07-16 from five
  scattered crons. README says 4×/day, MAINTENANCE.md says 4×, FILES.md says 5× and lists
  the dead cron times. All wrong.
- **`daily-audit.yml` runs twice daily** (02:00 and 14:00) despite the name.
- **README.md is historical and disowned** by FILES.md. MAINTENANCE.md is the source of truth.
- FILES.md has a corrupted markdown table around lines 106–108.

## Branch discipline — enforced in code, don't work around it

UI work happens on `staging`. Data-only changes go straight to `main`. Promotion is
**not a merge** — `scripts/promote-to-live.sh` copies staging's `index.html` wholesale
onto main, because staging deliberately lags main on scripts and data.

`scripts/hooks/pre-commit` (wired via `core.hooksPath`) blocks committing
`public/index.html` on `main` unless `JD_PROMOTE=1`. Both guardrails were added after a
2026-08-15 near-miss that would have silently reverted four commits. There is also a
`_TESTDATA` marker convention with a pre-commit tripwire so preview data can't reach main.

## CI

| Workflow | Schedule |
|---|---|
| `update-data.yml` | hourly, `7 * * * *` |
| `daily-audit.yml` | `0 2 * * *` and `0 14 * * *` |
| `detect-topic-candidates.yml` | `30 4 * * *` |
| `fetch-transcripts.yml` | dormant — YouTube blocks GitHub IP ranges |
| `backfill-transcripts.yml` | manual only, already run |

All three main-committing workflows share `concurrency: main-data-push` because delayed
crons bunch together and race each other on `meta.lastUpdated`.

**The staleness tripwire matters.** Snapshot steps are `continue-on-error` by design, so a
dead token would keep every run green while the archive silently stopped growing. The final
step — deliberately *not* continue-on-error — queries the GitHub API for the newest commit
filtered to `path=snapshots` (unfiltered would always look fresh, since the debut sampler
commits hourly) and fails at ≥36h.

Secrets: `YOUTUBE_API_KEY`, `SNAPSHOTS_REPO_TOKEN`, `TRANSCRIPTS_REPO_TOKEN`.

## Open items

- ⚠️ **`SNAPSHOTS_REPO_TOKEN` expires ~September 2026.** Needs manual rotation.
- **Entanglement window disagreement.** `build-ad-ledger.py` uses `ENTANGLE_DAYS = 3`
  (measured: across 83 fully-captured launches the median video hits 91.7% of its day-21
  total by 48h). `measure-campaign-yield.js` still uses `AGE_MIN = 14` *and* its header
  comment falsely claims "this is the same 14-day line ad-ledger.json already draws".
- `detect-spikes.js` ~line 200: `'...' + arr.map(...).join('; ') || '(none)'` — `+` binds
  tighter than `||`, so `(none)` can never print.
- `detect-spikes.js` derives `newsLikely` from `topic-tags.json`, stale since 2026-06-20
  and superseded by `topic-tags-llm.json`.
- `build-ad-ledger.py` uses `utcfromtimestamp()`, deprecated in the Python 3.12 CI pins.
- `measure-*.js` write `public/view-count-change.json`, which only exists on `staging` —
  running from a `main` checkout throws on the initial read.
- `scripts/run-scrape-ads.cmd:6` resolves Python via `%LOCALAPPDATA%`. It previously
  hardcoded a user-profile path, publishing the local account name to a public repo.
  Keep local paths out of tracked files — the real ones live in `PATHS.local.md`.
- `scripts/filler-tally.js:16` hardcodes `C:/tmp/transcripts-repo/transcripts`, no env override.
- `public/reposts.json` is hand-maintained. No watermark scanner exists here — that lives
  in `../content-theft-tracker`.
- `tag-topics.js` is legacy, superseded by an LLM tagger that is not in this repo.

## Fragile by nature

`scrape-ads.py` parses raw protobuf field numbers out of an undocumented internal Google
endpoint. Mitigated by failing closed (`--min-ads 50`), but it will break when Google
renumbers. `resolve-removed-reasons.js` regexes `ytInitialPlayerResponse` out of watch-page
HTML and string-matches English error copy. Three builders hardcode the archive start
`2026-06-11` — nothing before that is measurable, ever.

## Running it

```powershell
./serve.ps1                                   # file:// breaks the fetch()es
$env:YOUTUBE_API_KEY = "..."
node scripts/fetch-data.js [--backfill|--audit]
node scripts/resolve-removed-reasons.js [--refresh 7|--all]
$env:SNAPSHOTS_DIR = "..\jerminaldecline-snapshots\snapshots"
python scripts/build-view-velocity.py
python scripts/build-ad-ledger.py
python scripts/scrape-ads.py [--apply --commit]
./scripts/promote-to-live.sh ["subject"]
```

## House style — match it

Comments record **why**, with the date and the specific incident that motivated the change,
and the measured numbers behind any constant. Methodological honesty is enforced in the data
itself: `view-spikes.json` refuses to call an anomaly an ad, `ad-ledger.json` refuses to claim
entangled launch traffic, `ad-yield.json` labels CPV as "the one borrowed number". Absence of
evidence must never read as evidence of absence — fail closed. There are no TODO/FIXME markers
anywhere in this repo; keep it that way.

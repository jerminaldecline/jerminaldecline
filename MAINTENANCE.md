# Maintenance guide

How to keep jerminaldecline.com running and up to date. Covers what's automated, what needs manual work, and how to do each manual task.

---

## What's fully automated

These run on a schedule via GitHub Actions. No action needed — just check occasionally that the workflows aren't failing in the Actions tab.

| Workflow | Schedule | What it updates |
|---|---|---|
| `update-data.yml` | 4× daily | `data.json`, `descriptions.json` |
| `daily-audit.yml` | Daily, 02:00 UTC | Backfills any missing data, integrity checks |
| `detect-topic-candidates.yml` | Nightly, 04:30 UTC | `topic-candidates.md`, `topic-trackers.json` |

**Note:** `descriptions.json` is part of the automated pipeline. The `fetch-data.js` script writes it together with `data.json` on every run.

---

## Dormant workflows (don't run, kept for emergency)

These exist in `.github/workflows/` but are inactive — leave them alone:

- `fetch-transcripts.yml` — daily incremental, schedule commented out (YouTube blocks GitHub Actions IPs)
- `backfill-transcripts.yml` — manual-only one-off (already ran)

Both could be re-enabled if YouTube ever unblocks GitHub IPs. For now, transcripts are managed locally.

---

## Manual tasks — scheduled

### 1. Weekly: topic refresh

**What:** Fetches new video transcripts, re-tags all TQ long-form videos with primary topics.

**Why manual:** YouTube blocks GitHub Actions IPs for transcript fetching. Must run from a residential connection.

**How:**

```powershell
cd "<runner>"
.\refresh-topics.ps1
```

The script does everything: refreshes data.json and topics.json from the main repo, fetches new transcripts, runs the tagger, copies the result back to the main repo, commits, and pushes.

Runtime: 3-5 minutes typical.

**Frequency:** Weekly is fine. Skipping a week just means a few extra videos to catch up on next time.

**Requirements:** `$env:TRANSCRIPTS_REPO_TOKEN` and `$env:TRANSCRIPTS_REPO` must be set as user environment variables.

### 2. Monthly: ad data review

**What:** Catalogue new Google Ads campaigns from the Marketing Sheriff advertiser entity.

**Why manual:** No automation yet (TODO: `scripts/match-ads.js`).

**How:**

1. Visit https://adstransparency.google.com/advertiser/AR13693796838614761473
2. For each new ad pointing to a YouTube video on one of the tracked channels (@TheQuartering, @JeremyHambly, @UnSleevedMedia, @rcnightmare, @QuarteringLive), grab the video ID
3. Add a new entry to `videos[]` in `public/ad-videos.json`:
   ```json
   {
     "id": "abc123XYZ",
     "channelHandle": "@TheQuartering",
     "title": "video title at time of cataloguing"
   }
   ```
4. Update `meta.lastUpdated` to today's date
5. Commit and push:
   ```powershell
   cd "<repo>"
   git add public/ad-videos.json
   git commit -m "Ad data: add N new campaigns"
   git push
   ```

**Frequency:** Monthly-ish. New campaigns appear gradually.

**Measuring an ad's view impact:** Once a campaign is running on a video that's
past its organic burst (>~48h old, so velocity is flat), you can estimate how
many views the ad drove:

```powershell
node scripts/ad-impact.js <videoId>          # auto-detects the latest run
node scripts/ad-impact.js <videoId> --from 2026-06-28 --quiet
```

It reads the twice-daily archive in the sibling `jerminaldecline-snapshots`
repo, establishes the flat organic baseline from the quiet period before the
spike, and reports `AD-DRIVEN VIEWS = observed gain − expected organic` across
the run window. Re-run as new snapshots land to watch the running total until
the campaign tapers back to baseline. (Only clean for older videos — a freshly
published video's organic and ad views are entangled.)

**Detecting *unflagged* promotion:** `node scripts/detect-spikes.js` sweeps every
aged long-form video NOT in `ad-videos.json` for the same flat-then-spike
pattern and writes `public/view-spikes.json`. A hit is an *anomaly* (possible
undisclosed ad, off-platform promotion, or a news/viral resurface), not a
confirmed paid ad — output is labelled accordingly and carries a `newsLikely`
hint. Research-only for now: nothing on the site reads `view-spikes.json` yet
(a UI panel would be a separate, staging-reviewed change).

### 3. Monthly-ish: review story tracker candidates

**What:** Glance at `public/topic-candidates.md` (auto-generated nightly) to see if any new story arcs deserve curated labels.

**How:**

1. Open `public/topic-candidates.md` in the repo (or read it on GitHub)
2. Look for clusters that have been spiking but aren't yet labelled in `topic-labels.json`
3. If you want one tracked properly with a curated name, add to `topic-labels.json` — see "Story tracker labels" below

**Frequency:** Monthly is plenty. The story tracker on the site only shows clusters above 30% saturation, so most candidates are short-lived noise.

---

## Manual tasks — as needed

### Story tracker labels

When the story tracker shows a noisy/wrong label (e.g. the detector picked "trial" instead of "Karmelo Anthony"), edit `public/topic-labels.json`.

```powershell
cd "<repo>"
# Edit public/topic-labels.json
git add public/topic-labels.json
git commit -m "Story labels: refine X"
git push
```

Schema and full options documented in the `_comment` field of `topic-labels.json` itself.

Takes effect on next Cloudflare deploy (~1 minute).

### Topic taxonomy edits

When you want to add a new topic to the timeline, refine keywords, or change colors, edit `public/topics.json`.

```powershell
cd "<repo>"
# Edit public/topics.json
git add public/topics.json
git commit -m "Topics: add/refine X"
git push

# Then re-tag all videos against the new taxonomy:
cd "<runner>"
.\refresh-topics.ps1
```

### Site changes (index.html and assets)

Standard edit-commit-push. Cloudflare auto-deploys.

```powershell
cd "<repo>"
# Edit public/index.html or other files
git add .
git commit -m "Site: describe change"
git push
```

---

## Annual reminders

Set calendar reminders with 2-week warnings — token expiry causes silent CI failures you might not notice for a while.

| Item | Expires | What to do |
|---|---|---|
| `SNAPSHOTS_REPO_TOKEN` | ~September 2026 | Regenerate fine-grained PAT for `jerminaldecline-snapshots`, update GitHub secret |
| `TRANSCRIPTS_REPO_TOKEN` | ~June 2027 | Regenerate fine-grained PAT for `jerminaldecline-transcripts`, update GitHub secret AND user env var |

---

## Reference: file map

### Main repo (`jerminaldecline`)

| File | What it is | Maintenance |
|---|---|---|
| `public/data.json` | Video metadata + stats | Auto (4× daily) |
| `public/descriptions.json` | Full video descriptions | Auto (4× daily) |
| `public/topic-candidates.md` | Detected story candidates | Auto (nightly) |
| `public/topic-trackers.json` | Story tracker data for site | Auto (nightly) |
| `public/topic-labels.json` | Story tracker label overrides | Manual, as needed |
| `public/topics.json` | Timeline topic taxonomy | Manual, as needed |
| `public/topic-tags.json` | Per-video topic tags | Manual via `refresh-topics.ps1`, weekly |
| `public/ad-videos.json` | Confirmed Google Ads campaigns | Manual, monthly |
| `public/index.html` | The site itself | Manual edits |
| `public/*.png`, `*.ico`, `*.gif` | Static assets | Rarely edited |

### Sister repo (`jerminaldecline-transcripts`) — private

| File | What it is | Maintenance |
|---|---|---|
| `transcripts/<videoId>.json` | One file per video transcript | Auto via fetcher (run locally) |
| `index.json` | Fetched/failure status per video ID | Auto via fetcher |

### Snapshots repo (`jerminaldecline-snapshots`) — public

Daily archive of data.json. Auto-populated. No manual maintenance.

### Local runner workspace

| File | What it is |
|---|---|
| `scripts/fetch-transcripts.js` | Transcript fetcher (sister repo writer) |
| `scripts/tag-topics.js` | Topic tagger |
| `refresh-topics.ps1` | One-command weekly maintenance script |
| `public/data.json` | Local copy, refreshed by `refresh-topics.ps1` |
| `public/topics.json` | Local copy, refreshed by `refresh-topics.ps1` |
| `public/topic-tags.json` | Local output of tagger, then copied to main repo |

---

## When something breaks

**CI workflow fails:** Check the Actions tab on GitHub. Most failures are token expiry or transient YouTube API issues. The daily audit will often catch and repair issues.

**Local script fails:** First try re-running it once — most issues are transient (network blip, GitHub conflict). If it consistently fails, the most common causes are:
- Token expired or not set
- Folder paths changed (edit the paths at the top of `refresh-topics.ps1`)
- Sister repo permissions changed (regenerate PAT)

**Topic tags look wrong:** Edit `topics.json`, push, re-run `refresh-topics.ps1`.

**Story tracker shows wrong label:** Edit `topic-labels.json`, push. Effect is immediate on next page load.


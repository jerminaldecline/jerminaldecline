#!/usr/bin/env python3
"""scrape-ads.py — reconcile public/ad-videos.json against the Google Ads
Transparency Center for the "Marketing Sheriff" advertiser.

Why a browser: the Transparency Center is a JS SPA, so a plain HTTP fetch only
returns an empty shell. We drive headless Chromium (Playwright), scroll until
the ad list stops growing, and harvest the advertised YouTube video IDs from the
`i.ytimg.com/vi/<ID>/` thumbnail requests every video-ad card makes.

Modes:
  (default)   report the diff only — no writes
  --apply     add MISSING ids to ad-videos.json (mapped to channel via its
              channelId, lists re-sorted, meta.lastUpdated bumped). Never
              removes the "stale" ids (ads that stopped and aged off the page).
  --commit    with --apply: git add/commit/push the change (ad data -> main,
              per the project's data-update rule). No-op if nothing changed.
  --json      machine-readable summary on stdout.
  --headful   show the browser (debugging).
  --min-ads N safety floor (default 50): if the scrape harvests fewer than N
              ids, abort WITHOUT writing — guards against a bot-block/empty load.

Requires Playwright + Chromium (installed locally). Run from anywhere; paths are
resolved relative to this file.
"""
import re, sys, json, time, os, subprocess, datetime
from pathlib import Path

ADVERTISER = "AR13693796838614761473"
URL = f"https://adstransparency.google.com/advertiser/{ADVERTISER}?region=anywhere"
ROOT = Path(__file__).resolve().parent.parent
ADS_FILE = ROOT / "public" / "ad-videos.json"
DATA_FILE = ROOT / "public" / "data.json"

APPLY   = "--apply" in sys.argv
COMMIT  = "--commit" in sys.argv
ASJSON  = "--json" in sys.argv
HEADFUL = "--headful" in sys.argv
MIN_ADS = int(sys.argv[sys.argv.index("--min-ads")+1]) if "--min-ads" in sys.argv else 50

def log(*a):
    if not ASJSON: print(*a, flush=True)

def scrape_ids():
    from playwright.sync_api import sync_playwright
    rx = [re.compile(r"i\.ytimg\.com/vi/([A-Za-z0-9_-]{11})/"),
          re.compile(r"youtube\.com/(?:embed/|watch\?v=)([A-Za-z0-9_-]{11})"),
          re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})")]
    ids = set()
    def on_req(req):
        for r in rx:
            m = r.search(req.url)
            if m: ids.add(m.group(1))
    with sync_playwright() as p:
        b = p.chromium.launch(headless=not HEADFUL)
        ctx = b.new_context(viewport={"width":1400,"height":1000},
              user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
        pg = ctx.new_page(); pg.on("request", on_req)
        log("loading advertiser page...")
        pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(4000)
        for sel in ['button:has-text("Accept all")','button:has-text("Reject all")',
                    'button:has-text("I agree")','form[action*="consent"] button']:
            try:
                el = pg.query_selector(sel)
                if el: el.click(); pg.wait_for_timeout(1500); break
            except Exception: pass
        stable = 0; last = -1
        for i in range(150):
            pg.mouse.wheel(0, 4000); pg.keyboard.press("End"); pg.wait_for_timeout(1200)
            n = len(ids)
            stable = stable+1 if n == last else 0
            last = n
            if stable >= 8: break
        b.close()
    return ids

def main():
    ads = json.loads(ADS_FILE.read_text(encoding="utf-8"))
    data = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    meta = {v["id"]: v for v in data["videos"]}
    cid2handle = {c["channelId"]: h for h, c in ads["channels"].items()}
    flagged = set(i for c in ads["channels"].values() for i in c["videoIds"])

    scraped = scrape_ids()
    if len(scraped) < MIN_ADS:
        log(f"ABORT: only {len(scraped)} ids harvested (< --min-ads {MIN_ADS}); "
            "likely a bot-block/empty load. No changes made.")
        if ASJSON: print(json.dumps({"ok": False, "scraped": len(scraped)}))
        sys.exit(2)

    # Two-run confirmation before a video earns the ad badge.
    #
    # The harvest is a heuristic: it captures any YouTube id appearing in network
    # traffic on the advertiser page, so a single transient appearance is
    # indistinguishable from a real campaign. On 2026-08-10 that put a permanent
    # "AD" badge on a video off one 11:00 sighting that never reproduced in three
    # later runs. Requiring an id in two consecutive runs costs at most a day's
    # delay on a genuine campaign and stops one-offs becoming published claims.
    pending = dict(ads.get("meta", {}).get("pending", {}))
    seen_now = sorted(scraped - flagged)
    confirmed = [i for i in seen_now if i in pending]        # seen last run too
    first_seen = [i for i in seen_now if i not in pending]   # hold for next run
    dropped = [i for i in pending if i not in scraped]       # one-off, never reappeared

    missing = confirmed
    stale   = sorted(flagged - scraped)
    unknown = [i for i in missing if i not in meta]

    def title(i):
        v = meta.get(i)
        return f"{v.get('title','')[:60]}" if v else "(not in data.json)"

    log(f"\nTransparency Center: {len(scraped)} ads   |   ad-videos.json: {len(flagged)}")
    log(f"MISSING (add): {len(missing)}   STALE (stopped, kept): {len(stale)}   UNKNOWN ids: {len(unknown)}")
    for i in missing: log(f"  + {i}  {title(i)}  (confirmed in 2 consecutive runs)")
    for i in first_seen: log(f"  ? {i}  {title(i)}  (seen once — held until it reappears)")
    for i in dropped: log(f"  - {i}  {title(i)}  (one-off, never reappeared — discarded)")

    added = {}
    if APPLY:
        today = datetime.date.today().isoformat()
        # Carry forward only ids seen THIS run; anything held from last run that
        # didn't reappear is dropped. This must be written even when nothing is
        # added, or the confirmation never has a previous run to compare against.
        new_pending = {i: pending.get(i, today) for i in first_seen}
        changed = bool(missing) or new_pending != pending

        if missing:
            for i in missing:
                v = meta.get(i); h = cid2handle.get(v.get("channelId")) if v else None
                if not h:
                    log(f"  !! cannot place {i} (unknown channel) — skipped"); continue
                ads["channels"][h]["videoIds"].append(i); added[h] = added.get(h, 0) + 1
            for c in ads["channels"].values():
                c["videoIds"] = sorted(set(c["videoIds"]))
            ads["meta"]["lastUpdated"] = today
            log(f"\nApplied: {added}  (total now {sum(len(c['videoIds']) for c in ads['channels'].values())})")

        ads["meta"]["pending"] = new_pending
        if changed:
            ADS_FILE.write_text(json.dumps(ads, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

        # Refresh the spike detector against the LATEST snapshots every run — so a
        # fresh velocity bump on an already-catalogued video is caught even in a
        # week with no new ads. Pull the snapshots sibling repo first so it's current.
        snap_dir = os.environ.get("SNAPSHOTS_DIR")
        snap_repo = Path(snap_dir).parent if snap_dir else (ROOT.parent / "jerminaldecline-snapshots")
        if snap_repo.exists():
            subprocess.run(["git", "pull", "--ff-only", "-q"], cwd=snap_repo)
        subprocess.run(["node", str(ROOT/"scripts"/"detect-spikes.js"), "--quiet"], cwd=ROOT)

        if COMMIT:
            # SAFETY GUARDS: this runs unattended (scheduled task, Sundays) inside the
            # active dev checkout, which is sometimes on `staging` for UI work. Without
            # the branch check the commit would strand on staging while `push origin
            # main` reports success ("Everything up-to-date"). And an unchecked rebase
            # conflict would leave the repo mid-rebase for every future run.
            branch = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=ROOT,
                                    capture_output=True, text=True).stdout.strip()
            if branch != "main":
                log(f"ABORT commit: repo is on '{branch}', not main. Ad data written locally but NOT committed.")
                sys.exit(3)
            subprocess.run(["git", "add", "public/ad-videos.json", "public/view-spikes.json"], cwd=ROOT, check=True)
            staged = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT)
            if staged.returncode != 0:           # something actually changed
                n = sum(added.values())
                msg = (f"Ad data: auto-reconcile (+{n} campaigns) + refresh spike detector"
                       if missing else "Ad data: refresh view-spikes (new bumps on existing ads)")
                subprocess.run(["git", "commit", "-m", msg], cwd=ROOT, check=True)
                pushed = False
                for attempt in range(3):        # bots push to main 5x/day; retry the race
                    rb = subprocess.run(["git", "pull", "--rebase", "origin", "main", "-q"], cwd=ROOT)
                    if rb.returncode != 0:
                        subprocess.run(["git", "rebase", "--abort"], cwd=ROOT)
                        log("ABORT push: rebase conflict on pull; commit left local, repo restored.")
                        sys.exit(3)
                    if subprocess.run(["git", "push", "origin", "main"], cwd=ROOT).returncode == 0:
                        pushed = True
                        break
                if not pushed:
                    log("Push failed after 3 attempts; commit left local.")
                    sys.exit(3)
                log(f"Committed and pushed{f' (+{n} new ads)' if missing else ''}.")
            else:
                log("No changes to commit.")

    if ASJSON:
        print(json.dumps({"ok": True, "scraped": len(scraped), "catalogued": len(flagged),
                          "missing": missing, "stale": stale, "unknown": unknown, "added": added}))

if __name__ == "__main__":
    main()

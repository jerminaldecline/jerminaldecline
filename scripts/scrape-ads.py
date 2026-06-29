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
import re, sys, json, time, subprocess, datetime
from pathlib import Path

ADVERTISER = "AR13693796838614761473"
URL = f"https://adstransparency.google.com/advertiser/{ADVERTISER}?region=anywhere"
ROOT = Path(__file__).resolve().parent.parent
ADS_FILE = ROOT / "public" / "ad-videos.json"
DATA_FILE = ROOT / "public" / "data.json"
DATES_FILE = ROOT / "public" / "ad-dates.json"

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

def update_ad_dates(scraped):
    """Presence tracking: record first/last date each video was seen advertised.
    This is the reliable 'last ad run' signal (weekly precision) — the
    Transparency Center doesn't expose a date->video mapping we can trust, so we
    use the fact that the weekly scrape already lists every currently-running ad.
    lastSeen freezes when a video drops out of the scrape (~ campaign ended).
    Forward-looking: the clock starts when a video is first observed."""
    today = datetime.date.today().isoformat()
    obj = json.loads(DATES_FILE.read_text(encoding="utf-8")) if DATES_FILE.exists() else {
        "_note": "Per-video advertising presence from the weekly scrape. lastSeen = most "
                 "recent scrape the video was still advertised (~ last ad run, weekly "
                 "precision). Forward-looking: clock starts when first observed.", "videos": {}}
    vids = obj.setdefault("videos", {})
    changed = False
    for i in scraped:
        rec = vids.get(i)
        if not rec:
            vids[i] = {"firstSeen": today, "lastSeen": today, "seen": 1}; changed = True
        elif rec.get("lastSeen") != today:
            rec["lastSeen"] = today; rec["seen"] = rec.get("seen", 1) + 1; changed = True
    if changed:
        DATES_FILE.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return changed


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

    missing = sorted(scraped - flagged)
    stale   = sorted(flagged - scraped)
    unknown = [i for i in missing if i not in meta]

    def title(i):
        v = meta.get(i)
        return f"{v.get('title','')[:60]}" if v else "(not in data.json)"

    log(f"\nTransparency Center: {len(scraped)} ads   |   ad-videos.json: {len(flagged)}")
    log(f"MISSING (add): {len(missing)}   STALE (stopped, kept): {len(stale)}   UNKNOWN ids: {len(unknown)}")
    for i in missing: log(f"  + {i}  {title(i)}")

    added = {}
    dates_changed = False
    if APPLY:
        if missing:
            for i in missing:
                v = meta.get(i); h = cid2handle.get(v.get("channelId")) if v else None
                if not h:
                    log(f"  !! cannot place {i} (unknown channel) — skipped"); continue
                ads["channels"][h]["videoIds"].append(i); added[h] = added.get(h, 0) + 1
            for c in ads["channels"].values():
                c["videoIds"] = sorted(set(c["videoIds"]))
            ads["meta"]["lastUpdated"] = datetime.date.today().isoformat()
            ADS_FILE.write_text(json.dumps(ads, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            log(f"\nApplied: {added}  (total now {sum(len(c['videoIds']) for c in ads['channels'].values())})")
            subprocess.run(["node", str(ROOT/"scripts"/"detect-spikes.js"), "--quiet"], cwd=ROOT)
        # presence tracking runs EVERY scrape — lastSeen updates weekly even with no new ads
        dates_changed = update_ad_dates(scraped)
        if dates_changed: log("Updated ad-dates.json (advertising-presence tracking).")
        if COMMIT and (missing or dates_changed):
            files = ["public/ad-dates.json"]
            if missing: files += ["public/ad-videos.json", "public/view-spikes.json"]
            n = sum(added.values())
            msg = (f"Ad data: auto-reconcile (+{n} campaigns) + presence update" if missing
                   else "Ad data: weekly advertising-presence update")
            subprocess.run(["git", "add", *files], cwd=ROOT, check=True)
            subprocess.run(["git", "commit", "-m", msg], cwd=ROOT, check=True)
            subprocess.run(["git", "pull", "--rebase", "origin", "main", "-q"], cwd=ROOT)
            subprocess.run(["git", "push", "origin", "main"], cwd=ROOT, check=True)
            log("Committed and pushed.")

    if ASJSON:
        print(json.dumps({"ok": True, "scraped": len(scraped), "catalogued": len(flagged),
                          "missing": missing, "stale": stale, "unknown": unknown, "added": added}))

if __name__ == "__main__":
    main()

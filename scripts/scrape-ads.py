#!/usr/bin/env python3
"""scrape-ads.py — reconcile public/ad-videos.json against the Google Ads
Transparency Center for the "Marketing Sheriff" advertiser.

Why a browser: the Transparency Center is a JS SPA, so a plain HTTP fetch only
returns an empty shell. We drive headless Chromium (Playwright), scroll until
the ad list stops growing, and harvest the advertised YouTube video IDs from the
`i.ytimg.com/vi/<ID>/` thumbnail requests every video-ad card makes.

What earns a badge: a video is catalogued when the Centre holds a CREATIVE for
it — a dated campaign record read from the page's own SearchCreatives API — not
because a thumbnail request went past. The thumbnail harvest is still run, as a
cross-check and to spot campaigns that have stopped.

Note the Centre only retains roughly the last ~10 months of creatives, so a
video advertised before that has no record. Catalogued videos are therefore
never removed for lack of one; absence is only meaningful for a video newer
than the retention edge (see ad-campaigns.json "trackingFrom").

Modes:
  (default)   report the diff only — no writes
  --apply     add MISSING ids to ad-videos.json (mapped to channel via its
              channelId, lists re-sorted, meta.lastUpdated bumped). Never
              removes the "stale" ids (ads that stopped and aged off the page).
  --commit    with --apply: git add/commit/push the change (ad data -> main,
              per the project's data-update rule). No-op if nothing changed.
  --campaigns capture creatives and write ad-campaigns.json only; no reconcile.
  --json      machine-readable summary on stdout.
  --headful   show the browser (debugging).
  --min-ads N safety floor (default 50): if either the harvest or the creative
              capture comes back under N, abort WITHOUT writing — guards against
              a bot-block, an empty load, or a payload shape change.

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
CAMPAIGNS_FILE = ROOT / "public" / "ad-campaigns.json"
CREATIVE_CACHE = ROOT / "scripts" / "ad-creative-cache.json"

APPLY   = "--apply" in sys.argv
COMMIT  = "--commit" in sys.argv
ASJSON  = "--json" in sys.argv
HEADFUL = "--headful" in sys.argv
CAMPAIGNS = "--campaigns" in sys.argv
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


def scrape_creatives():
    """Capture the advertiser page's SearchCreatives responses.

    scrape_ids() reads video ids out of thumbnail requests and puts them in a set,
    so a video advertised several times counts once and a single stray request is
    indistinguishable from a real campaign. The page's own SearchCreatives API
    returns one record per creative with first-shown and last-shown timestamps —
    a dated, checkable claim, which is what the badge is now gated on.

    Runs its own browser session on purpose: scrape_ids() is what the rest of this
    script has always depended on and is left completely untouched.

    Returns [{creative, first_ms, last_ms, preview}], newest capture wins.
    """
    from playwright.sync_api import sync_playwright
    bodies = []
    with sync_playwright() as p:
        b = p.chromium.launch(headless=not HEADFUL)
        ctx = b.new_context(viewport={"width": 1500, "height": 1000},
              user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
        pg = ctx.new_page()
        pg.on("response", lambda r: bodies.append(r.text())
              if "SearchCreatives" in r.url else None)
        log("loading advertiser page for creatives...")
        pg.goto(URL, wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_timeout(4000)
        for sel in ['button:has-text("Accept all")', 'button:has-text("Reject all")',
                    'button:has-text("I agree")', 'form[action*="consent"] button']:
            try:
                el = pg.query_selector(sel)
                if el:
                    el.click(); pg.wait_for_timeout(1500); break
            except Exception:
                pass
        last, stable = -1, 0
        for _ in range(200):
            pg.mouse.wheel(0, 5000); pg.keyboard.press("End"); pg.wait_for_timeout(1000)
            n = sum(len(x) for x in bodies)
            stable = stable + 1 if n == last else 0
            last = n
            if stable >= 8:
                break
        b.close()

    out = {}
    for body in bodies:
        for chunk in re.split(r"\n(?=\{)", body):
            try:
                doc = json.loads(chunk)
            except Exception:
                continue
            for r in (doc.get("1") or []):
                cid = r.get("2")
                if not cid:
                    continue
                # Field numbers are protobuf tags and Google can renumber them, so
                # everything below is read defensively; a shape change yields fewer
                # records rather than a crash, and the caller aborts on too few.
                def ms(f):
                    try:
                        return int(f["1"]) * 1000
                    except Exception:
                        return None
                out[cid] = {
                    "creative": cid,
                    "first_ms": ms(r.get("6") or {}),
                    "last_ms": ms(r.get("7") or {}),
                    "preview": (((r.get("3") or {}).get("1") or {}).get("4") or ""),
                }
    return list(out.values())


def resolve_creative_videos(creatives):
    """Map each creative to the video it advertises, caching by creative id.

    The creative record carries no video id — only a preview URL. Fetching that
    preview returns the ad markup, which references exactly one YouTube id. Costly
    once, free afterwards: only creatives never seen before are fetched.
    """
    import urllib.request
    cache = {}
    if CREATIVE_CACHE.exists():
        try:
            cache = json.loads(CREATIVE_CACHE.read_text(encoding="utf-8"))
        except Exception:
            cache = {}
    todo = [c for c in creatives if c["creative"] not in cache and c["preview"]]
    log(f"resolving {len(todo)} new creatives to videos ({len(creatives) - len(todo)} cached)")

    yt = re.compile(r"(?:i\.ytimg\.com/vi/|youtube\.com/(?:watch\?v=|embed/)|youtu\.be/)"
                    r"([A-Za-z0-9_-]{11})")
    for i, c in enumerate(todo, 1):
        req = urllib.request.Request(c["preview"], headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
            "Referer": "https://adstransparency.google.com/"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8", "replace")
            m = yt.search(body)
            cache[c["creative"]] = m.group(1) if m else None
        except Exception:
            cache[c["creative"]] = None
        if i % 40 == 0:
            CREATIVE_CACHE.write_text(json.dumps(cache), encoding="utf-8")
            log(f"  resolved {i}/{len(todo)}")
        time.sleep(0.12)
    CREATIVE_CACHE.write_text(json.dumps(cache), encoding="utf-8")
    return cache


def build_campaigns(write=True):
    """Per-video run counts and campaign windows from the creative records.

    Returns the document, or None if the capture came back too thin to trust —
    the caller must treat None as "no evidence available this run" and add
    nothing, never as "nothing is advertised".
    """
    creatives = scrape_creatives()
    log(f"creatives captured: {len(creatives)}")
    if len(creatives) < MIN_ADS:
        log(f"ABORT: only {len(creatives)} creatives parsed (< --min-ads {MIN_ADS}); "
            "likely a bot-block or a payload shape change. Nothing written.")
        return None

    cache = resolve_creative_videos(creatives)
    day = lambda ms: datetime.datetime.utcfromtimestamp(ms / 1000).strftime("%Y-%m-%d") if ms else None

    videos, unresolved = {}, 0
    for c in creatives:
        vid = cache.get(c["creative"])
        if not vid:
            unresolved += 1
            continue
        e = videos.setdefault(vid, {"runs": 0, "windows": []})
        e["runs"] += 1
        if c["first_ms"] and c["last_ms"]:
            e["windows"].append([day(c["first_ms"]), day(c["last_ms"])])
    for v in videos.values():
        v["windows"].sort()
        if v["windows"]:
            v["first"] = v["windows"][0][0]
            v["last"] = max(w[1] for w in v["windows"])

    allw = [w for v in videos.values() for w in v["windows"]]
    doc = {
        "_note": "Per-video advertising history from the Google Ads Transparency Centre. "
                 "Each creative is one ad entry with its own first/last-shown dates, so a "
                 "video promoted repeatedly shows a run count above 1. Independent of "
                 "ad-ledger.json, which infers bursts from view snapshots and only reaches "
                 "back to 2026-06-11.",
        "_method": "SearchCreatives capture; each creative's preview resolved to its video",
        "_generated": datetime.date.today().isoformat(),
        "advertiser": "Marketing Sheriff",
        "creatives": len(creatives),
        "resolved": len(creatives) - unresolved,
        "unresolved": unresolved,
        "trackingFrom": min((w[0] for w in allw), default=None),
        "videos": videos,
    }
    if write:
        CAMPAIGNS_FILE.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8")
        log(f"\nwrote {CAMPAIGNS_FILE.name}: {len(videos)} videos, {len(creatives)} creatives, "
            f"{unresolved} unresolved, history from {doc['trackingFrom']}")
    return doc


def main():
    if CAMPAIGNS:                       # capture-only mode, no reconcile
        sys.exit(0 if build_campaigns() else 2)
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

    # A video earns the ad badge when the Transparency Centre holds a CREATIVE for
    # it — a dated campaign record with first/last-shown timestamps — not merely
    # because its thumbnail appeared in the page's network traffic.
    #
    # This replaced a two-run rule (badge only after an id showed up in two
    # consecutive runs), which was a proxy for evidence rather than evidence: it
    # still rested on the same thumbnail heuristic, and it cost a day's delay on
    # every genuine campaign. A creative record is checkable, carries the campaign
    # dates, and confirms on the first run. It also catches videos the thumbnail
    # harvest misses entirely.
    #
    # The capture is deliberately fail-closed. If it comes back thin — bot-block,
    # or Google renumbering the protobuf fields — build_campaigns returns None and
    # nothing is added. Absence of evidence must never read as evidence of absence,
    # because here that would silently stop detecting ads while reporting success.
    campaigns = build_campaigns(write=APPLY)   # default mode reports, never writes
    if campaigns is None:
        log("ABORT: no trustworthy creative capture this run; nothing added.")
        if ASJSON: print(json.dumps({"ok": False, "reason": "creative-capture-failed"}))
        sys.exit(2)

    evidenced = {v for v in campaigns["videos"] if v}
    missing = sorted(evidenced - flagged)
    # Harvested from thumbnails but with no creative behind it. Not badged, and
    # worth seeing in the log: a persistent entry here means the two sources
    # disagree, which is exactly the case the old rule couldn't distinguish.
    unevidenced = sorted(scraped - flagged - evidenced)
    stale   = sorted(flagged - scraped)
    unknown = [i for i in missing if i not in meta]

    def title(i):
        v = meta.get(i)
        return f"{v.get('title','')[:60]}" if v else "(not in data.json)"

    log(f"\nTransparency Center: {len(scraped)} ads harvested, {len(evidenced)} with creative records"
        f"   |   ad-videos.json: {len(flagged)}")
    log(f"MISSING (add): {len(missing)}   STALE (stopped, kept): {len(stale)}   UNKNOWN ids: {len(unknown)}")
    for i in missing:
        c = campaigns["videos"][i]
        log(f"  + {i}  {title(i)}  ({c['runs']} campaign(s), {c.get('first')} -> {c.get('last')})")
    for i in unevidenced:
        log(f"  ? {i}  {title(i)}  (in harvest, no creative record — not badged)")

    added = {}
    if APPLY:
        today = datetime.date.today().isoformat()
        # meta.pending belonged to the two-run rule. Clear it so a stale hold-list
        # can't be mistaken for live state by anything reading this file.
        changed = bool(missing) or "pending" in ads.get("meta", {})
        ads.get("meta", {}).pop("pending", None)

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

        # Re-measure what a campaign-day of advertising actually buys, now that
        # both this run's campaign windows and today's snapshots are in place.
        # Non-fatal: it exits non-zero when there is nothing new worth measuring,
        # and a stale ad-yield.json is better than aborting the whole reconcile.
        y = subprocess.run(["node", str(ROOT/"scripts"/"measure-campaign-yield.js"), "--quiet"], cwd=ROOT)
        if y.returncode != 0:
            log(f"  (campaign-yield measurement skipped, exit {y.returncode} — keeping the previous ad-yield.json)")

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
            subprocess.run(["git", "add", "public/ad-videos.json", "public/view-spikes.json",
                            "public/ad-campaigns.json", "public/ad-yield.json",
                            "scripts/ad-creative-cache.json"],
                           cwd=ROOT, check=True)
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

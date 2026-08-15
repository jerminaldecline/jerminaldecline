#!/usr/bin/env python3
"""Build public/ad-ledger.json — the PERMANENT record of confirmed ad-driven views.

The "suspicious movement" radar deliberately clears once a campaign stops; this
ledger is its durable counterpart. For every video in ad-videos.json (the
confirmed-ads catalogue) it walks the ENTIRE snapshot archive, finds every
burst interval (views gained well above the video's dormant baseline), and
accumulates the excess as ad-attributed views. Because it always re-scans the
full archive, the ledger only ever grows as campaigns run.

Attribution rule (same methodology as every ad analysis on this project):
an AGED video's organic gain is ~flat, so burst-period gain above baseline is
ad-driven. Bursts that start within ENTANGLE_DAYS of publish are counted
separately as "entangled" (launch traffic and paid traffic can't be separated)
and NOT claimed as confirmed ad views.

Long-form only. Only covers campaigns since the snapshot archive began
(2026-06-11) — earlier campaigns' views are invisible and never claimed.
Paths repo-relative; CI points SNAPSHOTS_DIR at its clone.
"""
import json, gzip, glob, os, datetime, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PUBLIC = os.path.join(REPO, "public")
SNAP = os.environ.get("SNAPSHOTS_DIR") or os.path.join(os.path.dirname(REPO), "jerminaldecline-snapshots", "snapshots")

# Bursts starting within this many days of publish are treated as launch traffic
# and never claimed as ad-driven, because organic and paid are inseparable there.
#
# MEASURED, not guessed. Across 83 TheQuartering long-form videos whose entire
# launch was captured by snapshots, the median video reaches (as a share of its
# day-21 total): 41.6% at 12h, 71.8% at 24h, 91.7% at 48h, 96.0% at 3d, 99.5% at
# 7d. So the launch IS the first two to three days, and by day 3 there is only 4%
# left to come — a burst after that cannot be launch decay.
#
# The old value of 14 was far too wide. It costs nothing today (every entangled
# burst on record starts on day 1, so 3 and 14 classify identically), but it would
# have refused to claim an ad run on day 5 against a video already 98.8% finished.
ENTANGLE_DAYS = 3
MIN_BURST_VIEWS = 200     # an interval must gain at least this ...
MIN_BURST_RATE = 300.0    # ... at at least this views/day pace ...
BASE_MULT = 3.0           # ... and at least this multiple of the dormant baseline rate
GAP_TOL = 2               # quiet intervals a run may bridge (~1 day): ad delivery pulses
                          # with the audience's waking hours, and at 2 checks/day those
                          # overnight lulls would otherwise split one campaign into
                          # several fake "runs" (only multi-day silence ends a run)

def snaptime(tag, snapdata=None):
    ts = ((snapdata or {}).get("meta") or {}).get("lastUpdated")
    if ts:
        try:
            return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).replace(tzinfo=None)
        except ValueError:
            pass
    d = datetime.datetime.fromisoformat(tag[:10])
    return d + datetime.timedelta(hours=10 if tag.endswith("AM") else 18)

def lab(tag):
    return datetime.date.fromisoformat(tag[:10]).strftime("%b%d") + " " + tag[11:]

def pub_dt(v):
    return datetime.datetime.fromisoformat(v["publishedAt"].replace("Z", "+00:00")).replace(tzinfo=None)

files = sorted(glob.glob(os.path.join(SNAP, "*.json.gz")))
if not files:
    raise SystemExit("no snapshots found at " + SNAP)
snaps, meta = [], {}
for f in files:
    tag = os.path.basename(f).replace(".json.gz", "")
    d = json.load(gzip.open(f))
    snaps.append((tag, snaptime(tag, d), {v["id"]: v.get("views", 0) for v in d["videos"]}))
    for v in d["videos"]:
        meta[v["id"]] = v
dates = [lab(t) for t, _, _ in snaps]
# Machine-readable twin of `dates`. The display labels ("Aug13 AM") carry no year,
# so the page cannot line a campaign window up against the axis from them. The
# chart needs that to shade WHEN THE ADS RAN as distinct from when the views
# moved — on ASMONGOLD BAN BACKFIRES the ads ran five days and the views moved on
# one, which the burst shading alone could never show.
iso_dates = [t[:10] for t, _, _ in snaps]

def _load(name, fb):
    try: return json.load(open(os.path.join(PUBLIC, name), encoding="utf-8"))
    except Exception: return fb

adcat = _load("ad-videos.json", {"channels": {}})
live = _load("data.json", {"channels": {}})
chan_title = {cid: c.get("title") or c.get("handle") for cid, c in live.get("channels", {}).items()}

LEDGER = []
for handle, entry in adcat.get("channels", {}).items():
    for vid in entry.get("videoIds", []):
        v = meta.get(vid)
        if not v or v.get("isShort"):
            continue
        pub = pub_dt(v)
        if sum(1 for _, _, s in snaps if vid in s) < 3:
            continue
        # per-interval gains at real timestamps; clamp corrections to zero
        # series aligned to the FULL snapshot list (chart x-axis); interval k sits
        # between snaps[k] and snaps[k+1] — bursts carry those indices for shading
        series = [s.get(vid) for _, _, s in snaps]
        ivals = []
        for i in range(1, len(series)):
            if series[i] is None or series[i - 1] is None: continue
            t0 = snaps[i - 1][1]; t1 = snaps[i][1]
            dt = (t1 - t0).total_seconds() / 86400.0
            if dt <= 0: continue
            gain = max(0, series[i] - series[i - 1])
            ivals.append({"iv": i - 1, "t0": t0, "t1": t1, "dt": dt, "gain": gain, "rate": gain / dt})
        if not ivals:
            continue
        base_rate = statistics.median(iv["rate"] for iv in ivals)
        # burst = interval well above the dormant pace
        bursts, cur, gap = [], None, 0
        for iv in ivals:
            excess = iv["gain"] - base_rate * iv["dt"]
            is_burst = (iv["gain"] >= MIN_BURST_VIEWS and iv["rate"] >= max(MIN_BURST_RATE, BASE_MULT * base_rate)
                        and excess > 0)
            if is_burst:
                if cur:
                    cur["views"] += round(excess); cur["_end"] = iv["t1"]; cur["iv1"] = iv["iv"]
                else:
                    cur = {"from": iv["t0"].date().isoformat(), "views": round(excess), "_end": iv["t1"], "iv0": iv["iv"], "iv1": iv["iv"]}
                gap = 0
            elif cur:
                gap += 1
                if gap > GAP_TOL:
                    bursts.append(cur); cur = None; gap = 0
        if cur: bursts.append(cur)
        for b in bursts:
            b["to"] = b.pop("_end").date().isoformat()
            b["entangled"] = (datetime.date.fromisoformat(b["from"]) - pub.date()).days < ENTANGLE_DAYS
        if not bursts:
            continue
        ad_views = sum(b["views"] for b in bursts if not b["entangled"])
        ent_views = sum(b["views"] for b in bursts if b["entangled"])
        LEDGER.append({
            "id": vid, "title": v["title"], "channelId": v["channelId"],
            "channel": chan_title.get(v["channelId"], handle),
            "publishedAt": v["publishedAt"][:10], "totalViews": next((x for x in reversed(series) if x is not None), 0),
            "series": series,
            "adViews": ad_views, "entangledViews": ent_views,
            "baselinePerDay": round(base_rate, 1),
            "bursts": [{k: b[k] for k in ("from", "to", "views", "entangled", "iv0", "iv1")} for b in bursts],
            "firstBurst": bursts[0]["from"], "lastBurst": bursts[-1]["to"],
        })

LEDGER.sort(key=lambda r: -r["adViews"])
OUT = {
    "_doc": ("Permanent ledger of confirmed ad-driven views for videos in ad-videos.json. "
             "adViews = views gained above the video's dormant baseline during burst periods "
             "starting >=14 days after publish (aged+flat => attributable to paid promotion). "
             "entangledViews = burst gains within 14 days of publish (launch and paid traffic "
             "inseparable; NOT claimed as ad-driven). Only campaigns since trackingStart are visible."),
    "trackingStart": "2026-06-11",
    "asOf": snaps[-1][0][:10],
    "dates": dates,
    "isoDates": iso_dates,
    "totals": {
        "adViews": sum(r["adViews"] for r in LEDGER),
        "entangledViews": sum(r["entangledViews"] for r in LEDGER),
        "videosWithConfirmedAdViews": sum(1 for r in LEDGER if r["adViews"] > 0),
    },
    "videos": LEDGER,
}
dst = os.path.join(PUBLIC, "ad-ledger.json")
with open(dst, "w", encoding="utf-8") as fh:
    json.dump(OUT, fh, separators=(",", ":"), ensure_ascii=False)
print("wrote", dst, "|", os.path.getsize(dst), "bytes")
print("  totals: adViews=%d entangled=%d videos=%d" % (
    OUT["totals"]["adViews"], OUT["totals"]["entangledViews"], len(LEDGER)))
for r in LEDGER[:8]:
    print("  %-46s ad=%-7d ent=%-7d bursts=%d (%s..%s)" % (
        r["title"][:46], r["adViews"], r["entangledViews"], len(r["bursts"]), r["firstBurst"], r["lastBurst"]))

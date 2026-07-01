#!/usr/bin/env python3
"""Build public/view-velocity.json for the site's "View Velocity" feature.

Per channel in the network, two datasets, both derived from the twice-daily
snapshots in the sibling jerminaldecline-snapshots repo:

  launch  - per-video views/day from launch (age 0), plus a "typical" curve
            (median views/day at each age, from that channel's launches in the
            last ~35 days) so a new video reads against how the channel behaves.
  movers  - videos that had gone FLAT (dormant baseline) and then suddenly
            jumped. That shape needs a flat history behind it, so it only ever
            surfaces old videos; a fresh launch never qualifies. Almost always
            an ad campaign (tagged) or a news moment.

Output keys each channel by channelId; the site picks the one matching the
channel-scope filter (and aggregates all of them + `allTypical` for "ALL").
Long-form only. Run from anywhere; paths are repo-relative.
"""
import json, gzip, glob, os, datetime, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PUBLIC = os.path.join(REPO, "public")
# Snapshots live in the sibling repo locally; CI (update-data.yml) clones them
# elsewhere and points here via SNAPSHOTS_DIR.
SNAP = os.environ.get("SNAPSHOTS_DIR") or os.path.join(os.path.dirname(REPO), "jerminaldecline-snapshots", "snapshots")

CUTOFF = datetime.date(2026, 6, 11)     # snapshots begin here => launch curves valid from here
MAXAGE = 13.0
MIN_AGE = 0.25                          # ignore snapshots < ~6h after publish as launch anchors:
                                        # a capture minutes after upload divides a big view count by
                                        # a tiny age and fabricates a huge day-0 "velocity" spike.
BENCH_DAYS = 35                         # rolling window for the "typical" benchmark
# movers detection. Movement = ACTUAL views gained between consecutive checks
# (~twice daily), NOT a per-day rate — so the figures reconcile with "views this
# week" and the chart (a single 12h burst reads as its real size, not doubled).
R = 8                                   # recent-movement window (~4 days of twice-daily snaps)
FLAT, MOVE, SPIKE = 100, 300, 3         # dormant<=FLAT, jump>=MOVE and >=SPIKE x baseline (per check)

def snaptime(tag):
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
    snaps.append((tag, snaptime(tag), {v["id"]: v.get("views", 0) for v in d["videos"]}))
    for v in d["videos"]:
        meta[v["id"]] = v
dates = [lab(t) for t, _, _ in snaps]
now = snaps[-1][1]
idx7 = max(0, len(snaps) - 14)

# ---- enrichment (topic chips + description snippet) from the live data files ----
def _load(name, fb):
    try: return json.load(open(os.path.join(PUBLIC, name), encoding="utf-8"))
    except Exception: return fb
_llm = _load("topic-tags-llm.json", {})
_topics = _load("topics.json", {})
_descs = _load("descriptions.json", {})
_descmap = _descs.get("descriptions", _descs) if isinstance(_descs, dict) else {}
_ads = set()
for c in _load("ad-videos.json", {"channels": {}}).get("channels", {}).values():
    _ads.update(c.get("videoIds", []))

def topics_for(vid):
    out = []
    for axis, lbl in (("tags", "subject"), ("themes", "theme"), ("modes", "format")):
        tid = _llm.get(axis, {}).get(vid); t = _topics.get(tid) if tid else None
        if isinstance(t, dict):
            out.append({"name": t.get("name", tid), "color": t.get("color", "#888"), "kind": lbl})
    return out
def desc_for(vid):
    d = _descmap.get(vid)
    if isinstance(d, dict): d = d.get("text") or d.get("description") or ""
    d = " ".join((d or "").split())
    return (d[:260] + "…") if len(d) > 260 else d

# ---- launch (age-velocity) ----
def series(vid):
    v = meta[vid]; pub = pub_dt(v)
    pts = [(0.0, 0)]
    for _, dt, vm in snaps:
        if vid in vm:
            age = (dt - pub).total_seconds() / 86400.0
            if age >= MIN_AGE: pts.append((age, vm[vid]))
    pts = sorted(set(pts))
    if len(pts) < 2: return None, None
    out = []
    for i in range(1, len(pts)):
        a0, w0 = pts[i-1]; a1, w1 = pts[i]
        if a1 - a0 <= 0: continue
        out.append([round((a0 + a1) / 2, 3), round((w1 - w0) / (a1 - a0))])
    return out, (round(pts[-1][0], 2), pts[-1][1])

def typ_from(allpts):
    bins = {}
    for a, r in allpts:
        bins.setdefault(round(a * 2) / 2.0, []).append(r)
    return [[k, round(statistics.median(vs))] for k, vs in sorted(bins.items()) if len(vs) >= 4 and k <= MAXAGE]

def launch_for(cid):
    vids = [v for v in meta.values()
            if v.get("channelId") == cid and not v.get("isShort") and not v.get("unavailable")
            and pub_dt(v).date() >= CUTOFF]
    VIDS, allpts, nbench = [], [], 0
    for v in sorted(vids, key=lambda x: x["publishedAt"], reverse=True):
        s, cur = series(v["id"])
        if not s: continue
        VIDS.append({"id": v["id"], "title": v["title"], "pub": v["publishedAt"][:10],
                     "age": cur[0], "views": cur[1], "pts": s,
                     "likes": v.get("likes", 0), "comments": v.get("comments", 0),
                     "dur": v.get("durationSec", 0), "topics": topics_for(v["id"]), "desc": desc_for(v["id"])})
        if (now - pub_dt(v)).days <= BENCH_DAYS:
            allpts += [(a, r) for a, r in s if a <= MAXAGE]; nbench += 1
    return VIDS, allpts, nbench

# ---- movers (flat-then-spike) ----
def movers_for(cid):
    MOVERS = []
    for vid, v in meta.items():
        if v.get("channelId") != cid or v.get("isShort") or v.get("unavailable"): continue
        vser = [s.get(vid) for _, _, s in snaps]
        vv = [(vser[i] - vser[i-1]) for i in range(1, len(vser))
              if vser[i] is not None and vser[i-1] is not None]
        if len(vv) < 12: continue
        before = vv[:-R]
        if len(before) < 10: continue
        baseBefore = statistics.median(before)
        recentPeak = max(vv[-R:])
        if not (baseBefore <= FLAT and recentPeak >= MOVE and recentPeak >= baseBefore * SPIKE): continue
        latest = snaps[-1][2].get(vid); old = snaps[idx7][2].get(vid)
        gain7 = (latest - old) if (latest is not None and old is not None) else 0
        age = (now.date() - pub_dt(v).date()).days
        MOVERS.append({"id": vid, "title": v["title"], "pub": v["publishedAt"][:10], "age": age,
                       "gain7": gain7, "views": latest, "base": round(baseBefore), "peak": round(recentPeak),
                       "isAd": vid in _ads, "likes": v.get("likes", 0), "comments": v.get("comments", 0),
                       "dur": v.get("durationSec", 0), "topics": topics_for(vid), "desc": desc_for(vid),
                       "series": vser})
    MOVERS.sort(key=lambda m: -m["gain7"])
    return MOVERS

# ---- per channel ----
CHANS = _load("data.json", {"channels": {}}).get("channels", {})
channels_out, pooled = {}, []
for cid, info in CHANS.items():
    VIDS, allpts, nbench = launch_for(cid)
    pooled += allpts
    channels_out[cid] = {
        "handle": info.get("handle"), "title": info.get("title"),
        "launch": {"nbench": nbench, "typical": typ_from(allpts), "videos": VIDS},
        "movers": {"videos": movers_for(cid)},
    }

OUT = {
    "asOf": snaps[-1][0][:10],
    "trackingStart": CUTOFF.isoformat(),
    "maxage": MAXAGE,
    "dates": dates,
    "params": {"flat": FLAT, "move": MOVE, "spike": SPIKE},
    "allTypical": typ_from(pooled),   # pooled network typical for the "ALL" scope
    "channels": channels_out,
}
dst = os.path.join(PUBLIC, "view-velocity.json")
with open(dst, "w", encoding="utf-8") as fh:
    json.dump(OUT, fh, separators=(",", ":"), ensure_ascii=False)
print("wrote", dst, "|", os.path.getsize(dst), "bytes")
for cid, c in channels_out.items():
    print("  %-16s launch=%-3d typ=%-2d movers=%d" % (
        (c["handle"] or cid), len(c["launch"]["videos"]), len(c["launch"]["typical"]), len(c["movers"]["videos"])))

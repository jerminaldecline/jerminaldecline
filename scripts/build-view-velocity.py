#!/usr/bin/env python3
"""Build public/view-velocity.json for the site's "View Velocity" feature.

Two datasets, both derived from the twice-daily snapshots in the sibling
jerminaldecline-snapshots repo:

  launch  - per-video views/day from launch (age 0), plus a "typical" curve
            (median views/day at each age, from launches in the last ~35 days)
            so a new video can be read against how his recent uploads behave.
  movers  - videos that had gone FLAT (dormant baseline) and then suddenly
            jumped. That shape needs a flat history behind it, so it only ever
            surfaces old videos; a fresh launch never qualifies. Almost always
            an ad campaign (tagged) or a news moment.

Long-form TheQuartering only. Run from anywhere; paths are repo-relative.
"""
import json, gzip, glob, os, datetime, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PUBLIC = os.path.join(REPO, "public")
# Snapshots live in the sibling repo locally; CI (update-data.yml) clones them
# elsewhere and points here via SNAPSHOTS_DIR.
SNAP = os.environ.get("SNAPSHOTS_DIR") or os.path.join(os.path.dirname(REPO), "jerminaldecline-snapshots", "snapshots")

TQ = "UCfwE_ODI1YTbdjkzuSi1Nag"
CUTOFF = datetime.date(2026, 6, 11)     # snapshots begin here => launch curves valid from here
MAXAGE = 13.0
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

# ============================ LAUNCH (age-velocity) ============================
def series(vid):
    v = meta[vid]; pub = pub_dt(v)
    pts = [(0.0, 0)]
    for _, dt, vm in snaps:
        if vid in vm:
            age = (dt - pub).total_seconds() / 86400.0
            if age >= 0: pts.append((age, vm[vid]))
    pts = sorted(set(pts))
    if len(pts) < 2: return None, None
    out = []
    for i in range(1, len(pts)):
        a0, w0 = pts[i-1]; a1, w1 = pts[i]
        if a1 - a0 <= 0: continue
        out.append([round((a0 + a1) / 2, 3), round((w1 - w0) / (a1 - a0))])
    return out, (round(pts[-1][0], 2), pts[-1][1])

launch_vids = [v for v in meta.values()
               if v.get("channelId") == TQ and not v.get("isShort") and not v.get("unavailable")
               and pub_dt(v).date() >= CUTOFF]
VIDS, allpts, nbench = [], [], 0
for v in sorted(launch_vids, key=lambda x: x["publishedAt"], reverse=True):
    s, cur = series(v["id"])
    if not s: continue
    VIDS.append({"id": v["id"], "title": v["title"], "pub": v["publishedAt"][:10],
                 "age": cur[0], "views": cur[1], "pts": s,
                 "likes": v.get("likes", 0), "comments": v.get("comments", 0),
                 "dur": v.get("durationSec", 0), "topics": topics_for(v["id"]), "desc": desc_for(v["id"])})
    if (now - pub_dt(v)).days <= BENCH_DAYS:
        allpts += [(a, r) for a, r in s if a <= MAXAGE]; nbench += 1
bins = {}
for a, r in allpts:
    bins.setdefault(round(a * 2) / 2.0, []).append(r)
TYP = [[k, round(statistics.median(vs))] for k, vs in sorted(bins.items()) if len(vs) >= 4 and k <= MAXAGE]

# ============================ MOVERS (flat-then-spike) =========================
idx7 = max(0, len(snaps) - 14)
MOVERS = []
for vid, v in meta.items():
    if v.get("channelId") != TQ or v.get("isShort") or v.get("unavailable"): continue
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

OUT = {
    "asOf": snaps[-1][0][:10],
    "trackingStart": CUTOFF.isoformat(),
    "launch": {"maxage": MAXAGE, "nbench": nbench, "typical": TYP, "videos": VIDS},
    "movers": {"dates": dates, "params": {"flat": FLAT, "move": MOVE, "spike": SPIKE}, "videos": MOVERS},
}
dst = os.path.join(PUBLIC, "view-velocity.json")
with open(dst, "w", encoding="utf-8") as fh:
    json.dump(OUT, fh, separators=(",", ":"), ensure_ascii=False)
print("wrote", dst)
print("  launch videos:", len(VIDS), "| typical points:", len(TYP), "| benchmark:", nbench)
print("  movers:", len(MOVERS), "| known ads:", sum(1 for m in MOVERS if m["isAd"]),
      "| unexplained:", sum(1 for m in MOVERS if not m["isAd"]))

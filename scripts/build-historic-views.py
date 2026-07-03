#!/usr/bin/env python3
"""Build public/historic-views.json — per month, the views gained by videos
published in EARLIER months (the back-catalogue's contribution).

The Overview's monthly report counts only videos published in the shown month,
so it understates what the channel earned that month by whatever the older
catalogue accrued. This measures that remainder, from the per-video snapshot
archive: for each calendar month, gain = views(last snapshot in month) -
views(first snapshot in month), summed over videos published before the month
began. Long-form and Shorts reported separately (the site shows long-form).

Only possible from 2026-06 onward (snapshots begin 2026-06-11; June is
partial and flagged as such). The current month is flagged inProgress.
Paths repo-relative; CI points SNAPSHOTS_DIR at its clone.
"""
import json, gzip, glob, os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PUBLIC = os.path.join(REPO, "public")
SNAP = os.environ.get("SNAPSHOTS_DIR") or os.path.join(os.path.dirname(REPO), "jerminaldecline-snapshots", "snapshots")

files = sorted(glob.glob(os.path.join(SNAP, "*.json.gz")))
if not files:
    raise SystemExit("no snapshots found at " + SNAP)

# group snapshot files by calendar month; keep only first + last per month
by_month = defaultdict(list)
for f in files:
    tag = os.path.basename(f).replace(".json.gz", "")
    by_month[tag[:7]].append(f)

live = json.load(open(os.path.join(PUBLIC, "data.json"), encoding="utf-8"))
is_short = {v["id"]: bool(v.get("isShort")) for v in live["videos"]}
chan_of = {v["id"]: v["channelId"] for v in live["videos"]}
# confirmed-ad catalogue: gains on these aged/dormant videos are paid traffic
try:
    _adcat = json.load(open(os.path.join(PUBLIC, "ad-videos.json"), encoding="utf-8"))
    AD_IDS = {i for c in _adcat.get("channels", {}).values() for i in c.get("videoIds", [])}
except Exception:
    AD_IDS = set()

def last_week_start(month):
    """ISO date 7 days before the 1st of `month` — the 'late previous month' floor."""
    import datetime as _dt
    d = _dt.date(int(month[:4]), int(month[5:7]), 1) - _dt.timedelta(days=7)
    return d.isoformat()

latest_month = max(by_month)
months_out = {}
for month in sorted(by_month):
    fs = by_month[month]
    first, last = fs[0], fs[-1]
    if first == last:
        continue                      # need two captures to measure a gain
    a = json.load(gzip.open(first))
    b = json.load(gzip.open(last))
    amap = {v["id"]: v.get("views", 0) for v in a["videos"]}
    month_start = month + "-01"
    lw = last_week_start(month)
    # per channel: [longGain, shortsGain, latePrevLong, paidLong]
    # (exclusive long-form buckets: paid > last-week-of-previous-month > older)
    per = defaultdict(lambda: [0, 0, 0, 0])
    for v in b["videos"]:
        if v["publishedAt"] >= month_start:
            continue                  # published this month or later — not historic
        if v["id"] not in amap:
            continue
        d = v.get("views", 0) - amap[v["id"]]
        if d == 0:
            continue
        cid = chan_of.get(v["id"], v["channelId"])
        if is_short.get(v["id"], v.get("isShort")):
            per[cid][1] += d
        else:
            per[cid][0] += d
            if v["id"] in AD_IDS:
                per[cid][3] += d
            elif v["publishedAt"][:10] >= lw:
                per[cid][2] += d
    tag0 = os.path.basename(first).replace(".json.gz", "")
    tag1 = os.path.basename(last).replace(".json.gz", "")
    months_out[month] = {
        "channels": {cid: {"long": g[0], "shorts": g[1], "lastWeek": g[2], "paid": g[3]} for cid, g in per.items()},
        "long": sum(g[0] for g in per.values()),
        "shorts": sum(g[1] for g in per.values()),
        "lastWeek": sum(g[2] for g in per.values()),
        "paid": sum(g[3] for g in per.values()),
        "windowFrom": tag0, "windowTo": tag1,
        # partial when the archive doesn't cover the month from its 1st
        "partial": not tag0.startswith(month + "-01"),
        "inProgress": month == latest_month,
    }

OUT = {
    "_doc": ("Views gained per calendar month by videos published BEFORE that month "
             "(the back-catalogue's contribution), from the twice-daily snapshot archive. "
             "long/shorts split; per-channel under channels{}. partial = archive doesn't "
             "cover the month from day 1 (true for 2026-06, tracking began Jun 11). "
             "Months before 2026-06 are unknowable and absent."),
    "trackingStart": "2026-06-11",
    "months": months_out,
}
dst = os.path.join(PUBLIC, "historic-views.json")
with open(dst, "w", encoding="utf-8") as fh:
    json.dump(OUT, fh, separators=(",", ":"), ensure_ascii=False)
print("wrote", dst, "|", os.path.getsize(dst), "bytes")
for m, r in months_out.items():
    print("  %s  long %+10s (last-week %s, paid %s, older %s)  shorts %+13s  %s%s" % (
        m, f"{r['long']:,}", f"{r['lastWeek']:,}", f"{r['paid']:,}",
        f"{r['long']-r['lastWeek']-r['paid']:,}", f"{r['shorts']:,}",
        "partial " if r["partial"] else "", "in-progress" if r["inProgress"] else ""))

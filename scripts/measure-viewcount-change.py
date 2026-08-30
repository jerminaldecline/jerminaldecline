#!/usr/bin/env python3
"""
Measure YouTube's 24 Aug 2026 view-counting change on the dormant back catalogue.

From that date a view counts from the first frame with no minimum watch time;
long-form previously needed roughly 30 seconds. Shorts have counted this way
since 31 Mar 2025 and act as a control.

WHY THIS SUPERSEDES THE EARLIER (ARCHIVED) VERSION
--------------------------------------------------
The first attempt differenced consecutive SNAPSHOTS and divided by elapsed
hours. That is wrong here, and produced a phantom 1.75x step on 28 Aug 2026.

fetch-data.js refreshes only the last RECENT_WINDOW_DAYS = 60 days of uploads on
a normal run (see scripts/fetch-data.js). Every older video is re-enriched
solely by `--audit`, which runs twice a day. The dormant back catalogue is
therefore 100% audit-refreshed: its stored view counts do not move between
audits however many snapshots are taken. Snapshots are written by the UPDATE
workflow on a different schedule, so a snapshot difference measures "how many
audits fell between these two snapshots", not a rate.

That went unnoticed while both schedules were steady and roughly aligned. When
GitHub's scheduler degraded on 26 Aug 2026 the alignment broke, and the
resulting sampling artefact looked exactly like the effect being measured.

THREE CORRECTIONS
-----------------
1. AUDIT-ALIGNED. YouTube's counters advance continuously; we only OBSERVE them
   at audits. So difference at audit boundaries and divide by true audit-to-audit
   elapsed time. Audit times come from the git log (local, no auth, full history)
   rather than the Actions API, which retains only 90 days.

2. PHASE-MATCHED. Audits land near 03:00 and 14:30 UTC, and the two legs differ
   by ~1.3x: 14:30->03:00 reads ~890 views/24h, 03:00->14:30 reads ~700. That is
   a real diurnal cycle, and it survives audit alignment. Early legs are
   therefore compared only with early legs.

3. CLOCK-QUALITY FILTERED. Legs outside 10.0-13.5h cover unequal phase mixes and
   cannot be matched, so they are dropped - and the count of drops is reported,
   because during a scheduler outage that is most of the window and the honest
   answer is "not measurable yet".

Usage:
    python scripts/measure-viewcount-change.py            # report
    python scripts/measure-viewcount-change.py --clock    # clock health only
"""
import os, gzip, json, io, sys, datetime, statistics, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, 'public')
SNAP = os.environ.get('SNAPSHOTS_DIR') or os.path.join(
    os.path.dirname(ROOT), 'jerminaldecline-snapshots', 'snapshots')

TQ = 'UCfwE_ODI1YTbdjkzuSi1Nag'
CHANGE = '2026-08-24'
DORMANT_BEFORE = '2026-06-25'      # comfortably outside the 60-day refresh window
LEG_MIN, LEG_MAX = 10.0, 13.5      # a well-formed half-day audit leg
SNAP_LAG_MAX = 14.0                # hours; beyond this no snapshot reflects the audit
CLOCK_ONLY = '--clock' in sys.argv


def audit_times():
    """Audit run times from the git log. An audit that changed nothing leaves no
    commit, but then the data did not move either, so nothing is lost."""
    out = subprocess.run(
        ['git', 'log', '--format=%ad', '--date=iso-strict', 'origin/main',
         '--grep=daily audit', '-400'],
        capture_output=True, text=True, cwd=ROOT)
    ts = []
    for line in out.stdout.strip().split('\n'):
        line = line.strip()
        if not line:
            continue
        try:
            ts.append(datetime.datetime.fromisoformat(line))
        except ValueError:
            pass
    return sorted(ts)


def build_pool():
    data = json.load(io.open(os.path.join(PUBLIC, 'data.json'), encoding='utf-8'))
    ads = set()
    for c in json.load(io.open(os.path.join(PUBLIC, 'ad-videos.json'),
                               encoding='utf-8'))['channels'].values():
        ads.update(c.get('videoIds', []))
    return {v['id']: bool(v.get('isShort')) for v in data['videos']
            if v.get('channelId') == TQ and not v.get('unavailable')
            and v.get('publishedAt', '')[:10] < DORMANT_BEFORE
            and v['id'] not in ads}


def read_snapshots(pool, since):
    snaps = []
    for f in sorted(x for x in os.listdir(SNAP)
                    if x.endswith('.json.gz') and x[:10] >= since):
        try:
            j = json.loads(gzip.open(os.path.join(SNAP, f)).read().decode('utf-8'))
        except Exception:
            continue
        t = datetime.datetime.fromisoformat(j['meta']['lastUpdated'].replace('Z', '+00:00'))
        L = S = 0
        for v in j['videos']:
            sid = pool.get(v['id'])
            if sid is None:
                continue
            n = v.get('views') or 0
            if sid:
                S += n
            else:
                L += n
        snaps.append({'t': t, 'L': L, 'S': S})
    return snaps


def legs(audits, snaps):
    """Each audit's values, read from the first snapshot at or after it."""
    obs = []
    for a in audits:
        nxt = next((s for s in snaps if s['t'] >= a), None)
        if not nxt or (nxt['t'] - a).total_seconds() / 3600 > SNAP_LAG_MAX:
            continue
        obs.append({'t': a, 'L': nxt['L'], 'S': nxt['S']})
    # Two audits resolving to the SAME snapshot carry identical values; keep one.
    ded = []
    for o in obs:
        if ded and o['L'] == ded[-1]['L'] and o['S'] == ded[-1]['S']:
            continue
        ded.append(o)

    good, dropped = [], []
    for i in range(1, len(ded)):
        a, b = ded[i - 1], ded[i]
        h = (b['t'] - a['t']).total_seconds() / 3600
        rec = {'t': b['t'], 'h': h,
               'L': (b['L'] - a['L']) / h * 24, 'S': (b['S'] - a['S']) / h * 24,
               'leg': 'early' if b['t'].hour < 9 else 'late'}
        (good if LEG_MIN <= h <= LEG_MAX else dropped).append(rec)
    return good, dropped


def main():
    audits = audit_times()
    if len(audits) < 10:
        print('Could not read audit times from the git log (need origin/main fetched).')
        return 1
    pool = build_pool()
    nL = sum(1 for s in pool.values() if not s)
    nS = sum(1 for s in pool.values() if s)
    since = (min(audits) - datetime.timedelta(days=2)).strftime('%Y-%m-%d')
    snaps = read_snapshots(pool, max(since, '2026-07-01'))
    good, dropped = legs(audits, snaps)

    print('audits found      : %d   (%s -> %s)' % (
        len(audits), audits[0].strftime('%d %b %H:%M'), audits[-1].strftime('%d %b %H:%M')))
    print('pool              : %d long-form, %d shorts (all audit-refreshed)' % (nL, nS))
    print('usable legs       : %d      dropped for irregular spacing: %d' % (len(good), len(dropped)))

    # ---- clock health ------------------------------------------------------
    recent = [r for r in (good + dropped) if r['t'] > audits[-1] - datetime.timedelta(days=7)]
    bad = [r for r in recent if not (LEG_MIN <= r['h'] <= LEG_MAX)]
    print('\nCLOCK HEALTH (last 7 days)')
    print('  legs %d, irregular %d (%.0f%%)' % (len(recent), len(bad),
                                                100 * len(bad) / len(recent) if recent else 0))
    # 20%, not a third. During the clean run to 26 Aug 2026 irregular legs were
    # ~5%; at 33% the sampling is already degraded enough to fabricate a step,
    # which is exactly what happened.
    frac = len(bad) / len(recent) if recent else 0
    if frac > 0.20:
        print('  DEGRADED - the audit schedule is drifting, so most legs cannot be')
        print('  phase-matched. Treat any factor below as provisional; the 14-day')
        print('  count restarts when spacing returns to ~12.6h / ~11.4h.')
    elif frac > 0.05:
        print('  marginal - some drift, watch it')
    else:
        print('  steady')
    if CLOCK_ONLY:
        return 0

    # ---- measurement -------------------------------------------------------
    med = statistics.median
    print('\nAUDIT-ALIGNED, PHASE-MATCHED  (change date %s)' % CHANGE)
    results = []
    for leg in ('early', 'late'):
        pre = [r for r in good if r['leg'] == leg and r['t'].strftime('%Y-%m-%d') < CHANGE]
        post = [r for r in good if r['leg'] == leg and r['t'].strftime('%Y-%m-%d') >= CHANGE]
        label = 'early (->03h)' if leg == 'early' else 'late  (->14h)'
        if len(pre) < 3 or len(post) < 2:
            print('  %s : pre n=%d post n=%d - too few to compare' % (label, len(pre), len(post)))
            continue
        pL, pS = med([r['L'] for r in pre]), med([r['S'] for r in pre])
        qL, qS = med([r['L'] for r in post]), med([r['S'] for r in post])
        cv = statistics.pstdev([r['L'] for r in pre]) / pL if pL else float('nan')
        did = (qL / pL) / (qS / pS) if pS and qS else float('nan')
        results.append(did)
        print('  %s' % label)
        print('    pre  n=%2d : long %6.0f/24h   shorts %6.0f/24h   (baseline CV %.0f%%)'
              % (len(pre), pL, pS, 100 * cv))
        print('    post n=%2d : long %6.0f/24h   shorts %6.0f/24h' % (len(post), qL, qS))
        print('    long %.3fx   shorts %.3fx   difference-in-differences %.3fx'
              % (qL / pL, qS / pS, did))

    if results:
        print('\n  factor across legs: %s' % ' / '.join('%.2fx' % r for r in results))
        print('  Shorts cannot be affected by the counting change - any move there is')
        print('  contamination, which is what the difference-in-differences removes.')
    post_days = sorted({r['t'].strftime('%d %b') for r in good
                        if r['t'].strftime('%Y-%m-%d') >= CHANGE})
    print('\n  post-change days with a usable leg: %s' % (', '.join(post_days) or 'none'))
    return 0


if __name__ == '__main__':
    sys.exit(main())

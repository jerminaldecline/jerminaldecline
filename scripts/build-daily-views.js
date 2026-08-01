#!/usr/bin/env node
/**
 * Build public/daily-views.json — daily VIEW GAINS across the network,
 * split by format (Shorts / long-form) and by content age (uploaded THIS
 * month vs. from PREVIOUS months), per channel.
 *
 * data.json only carries each video's *current* cumulative view count, so it
 * cannot say how many views arrived on a given day. That signal lives in the
 * sibling jerminaldecline-snapshots repo: twice-daily full dumps of every
 * video's viewCount. We diff consecutive daily snapshots per video and bucket
 * the gain. The "Daily views" panel reads this side-file — same arrangement as
 * removed-reasons.json.
 *
 * Day attribution (Central Time / Wisconsin): the creator is in Wisconsin, and
 * we want each day's figure to line up with HIS calendar day. We take one
 * snapshot per date (the AM dump, captured ~00-04 UTC ≈ ~19-23 CT the previous
 * evening — closest to Central midnight; PM as fallback). The gain between the
 * snapshot dated D and the snapshot dated D+1 covers, in CT terms, roughly the
 * whole of day D, so it is labelled D. Because snapshots are only twice-daily,
 * a "day" here is an approximate ~24h window, not an exact CT-midnight boundary.
 *
 * "This month vs previous months" is evaluated per day against that day's own
 * month, which is well-defined: the panel only ever shows days within a single
 * month, so a video published in that same month is "this month", anything
 * earlier is "previous months" (a video can't gain views before it exists, so
 * nothing later ever contributes).
 *
 * Usage:  node scripts/build-daily-views.js
 *         node scripts/build-daily-views.js --snapshots ../jerminaldecline-snapshots
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const snapArg = args.includes('--snapshots') ? args[args.indexOf('--snapshots') + 1] : null;
// SNAPSHOTS_DIR matches the convention used by the sibling Python builders so
// this drops into the same "Rebuild view-velocity.json" CI step unchanged.
const SNAP_DIR = path.resolve(snapArg || process.env.SNAPSHOTS_DIR || path.join(__dirname, '..', '..', 'jerminaldecline-snapshots', 'snapshots'));
const OUT = path.join(__dirname, '..', 'public', 'daily-views.json');

// Publish month in the creator's local (Central) time, cached per timestamp.
const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit' });
const _pmCache = new Map();
function pubMonthCT(iso) {
  if (!iso) return null;
  if (_pmCache.has(iso)) return _pmCache.get(iso);
  let ym;
  try { const o = {}; for (const x of _fmt.formatToParts(new Date(iso))) if (x.type !== 'literal') o[x.type] = x.value; ym = o.year + '-' + o.month; }
  catch (e) { ym = String(iso).slice(0, 7); }
  _pmCache.set(iso, ym);
  return ym;
}

function loadSnap(file) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP_DIR, file))));
  const m = new Map();
  for (const v of d.videos) m.set(v.id, v);
  return { videos: m, channels: d.channels || {}, at: (d.meta && Date.parse(d.meta.lastUpdated)) || 0 };
}

function main() {
  const all = fs.readdirSync(SNAP_DIR).filter(f => /^\d{4}-\d{2}-\d{2}-(AM|PM)\.json\.gz$/.test(f)).sort();
  // One file per date, preferring the AM dump (closest to Central midnight).
  const byDate = new Map();
  for (const f of all) {
    const date = f.slice(0, 10), half = f.slice(11, 13);
    const cur = byDate.get(date);
    if (!cur || (cur.half === 'PM' && half === 'AM')) byDate.set(date, { file: f, half });
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 2) { console.error('Need at least two daily snapshots.'); process.exit(1); }

  const days = {};
  const channelTitles = {};
  let prev = loadSnap(byDate.get(dates[0]).file);
  Object.entries(prev.channels).forEach(([id, c]) => { channelTitles[id] = c.title || c.handle || id; });

  for (let i = 1; i < dates.length; i++) {
    const labelDate = dates[i - 1];                 // gain over ~CT day = earlier snapshot's date
    const dayMonth = labelDate.slice(0, 7);         // this-month test is against the labelled day's month
    const cur = loadSnap(byDate.get(dates[i]).file);
    Object.entries(cur.channels).forEach(([id, c]) => { channelTitles[id] = c.title || c.handle || id; });

    // per-channel [newShort, newLong, oldShort, oldLong]
    const prevTime = prev.at || Date.parse(dates[i - 1] + 'T00:00:00Z');
    const perCh = {};
    for (const [id, v] of cur.videos) {
      const before = prev.videos.get(id);
      let gain;
      if (before) {
        gain = (v.views || 0) - (before.views || 0);
        if (gain <= 0) continue;                     // clamp drops (privatisations/corrections) to zero
      } else {
        // First time this video appears. Count its whole view count ONLY if it
        // is a genuinely new upload (published since the previous snapshot) —
        // those views all accrued inside this window, and skipping them would
        // drop every upload's debut burst (the biggest chunk of its views).
        // A video merely reappearing (un-privated, or re-added by the audit)
        // carries historical views that were NOT gained now, so skip it.
        const pub = Date.parse(v.publishedAt || '');
        if (!(pub > prevTime)) continue;
        gain = v.views || 0;
        if (gain <= 0) continue;
      }
      const isNew = pubMonthCT(v.publishedAt) === dayMonth;
      const idx = (isNew ? 0 : 2) + (v.isShort ? 0 : 1);
      const arr = perCh[v.channelId] || (perCh[v.channelId] = [0, 0, 0, 0]);
      arr[idx] += gain;
    }
    // Drop channels with no gains that day; round to ints.
    const rec = {};
    for (const [id, arr] of Object.entries(perCh)) {
      if (arr[0] || arr[1] || arr[2] || arr[3]) rec[id] = arr.map(n => Math.round(n));
    }
    days[labelDate] = rec;
    prev = cur;
  }

  const out = {
    _note: 'Daily view gains across the network, split by format (Shorts/long-form) and content age (this-month vs previous-months uploads), per channel. Value arrays are [newShort, newLong, oldShort, oldLong].',
    _method: 'consecutive daily snapshot diffs (jerminaldecline-snapshots); a new upload\'s full view count is counted on first appearance (debut burst), reappearances of old videos are ignored, negative deltas clamped to 0; days labelled in Central Time (Wisconsin)',
    _generated: new Date().toISOString().slice(0, 10),
    _range: { from: dates[0], to: dates[dates.length - 2] },
    _channels: channelTitles,
    days,
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  // Summary
  let tot = 0; const dcount = Object.keys(days).length;
  for (const rec of Object.values(days)) for (const arr of Object.values(rec)) tot += arr[0] + arr[1] + arr[2] + arr[3];
  console.log('daily-views.json: ' + dcount + ' days (' + out._range.from + ' → ' + out._range.to + '), ' + tot.toLocaleString() + ' total views counted');
}

main();

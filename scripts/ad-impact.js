#!/usr/bin/env node
/*
 * ad-impact.js — estimate how many views an ad campaign drove to a video.
 *
 * Reads the twice-daily snapshot archive (the sibling jerminaldecline-snapshots
 * repo) and reconstructs a single video's view count over time. For a video that
 * is past its organic burst (more than ~48h old), daily view velocity is
 * essentially flat, so any sustained jump above that flat baseline is
 * ad-driven. We measure the baseline from a quiet pre-spike window, then sum the
 * excess views above it across the run.
 *
 * Usage:
 *   node scripts/ad-impact.js <videoId> [options]
 *
 * Options:
 *   --from <YYYY-MM-DD>   First date to count ad impact from (default: auto —
 *                         the first interval whose rate exceeds the spike
 *                         threshold). Everything before --from defines baseline.
 *   --to <YYYY-MM-DD>     Last date to count to (default: latest snapshot).
 *   --baseline <n/day>    Override the auto-detected organic baseline (views/day).
 *   --threshold <x>       Spike detection multiple of baseline (default 8).
 *   --quiet               Suppress the per-snapshot table; print only the summary.
 *
 * Env:
 *   SNAPSHOTS_DIR   Path to the snapshots/ folder. Defaults to the sibling
 *                   repo: ../../jerminaldecline-snapshots/snapshots
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function fail(msg) { console.error('Error: ' + msg); process.exit(1); }

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { threshold: 8 };
let videoId = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--from') opts.from = argv[++i];
  else if (a === '--to') opts.to = argv[++i];
  else if (a === '--baseline') opts.baseline = parseFloat(argv[++i]);
  else if (a === '--threshold') opts.threshold = parseFloat(argv[++i]);
  else if (a === '--quiet') opts.quiet = true;
  else if (a.startsWith('--')) fail('unknown option ' + a);
  else if (!videoId) videoId = a;
  else fail('unexpected argument ' + a);
}
if (!videoId) fail('missing <videoId>.\n  Usage: node scripts/ad-impact.js <videoId> [--from D] [--to D] [--baseline n] [--quiet]');

const SNAP_DIR = process.env.SNAPSHOTS_DIR
  || path.join(__dirname, '..', '..', 'jerminaldecline-snapshots', 'snapshots');
if (!fs.existsSync(SNAP_DIR)) fail('snapshots dir not found: ' + SNAP_DIR + '\n  Set SNAPSHOTS_DIR to override.');

// ---- load series ---------------------------------------------------------
// Each snapshot file is "<YYYY-MM-DD>-<AM|PM>.json.gz", a full data.json copy.
// We treat AM as ~the start of day and PM as ~midday for fractional-day math.
const files = fs.readdirSync(SNAP_DIR)
  .filter(f => f.endsWith('.json.gz'))
  .sort(); // lexical sort == chronological for this naming scheme

const series = []; // { tag, date, half, t (days), title, views }
let title = null;
for (const f of files) {
  const m = f.match(/^(\d{4}-\d{2}-\d{2})-(AM|PM)\.json\.gz$/);
  if (!m) continue;
  const [, date, half] = m;
  let data;
  try {
    data = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP_DIR, f))).toString('utf8'));
  } catch (e) { console.error('  (skipping unreadable ' + f + ': ' + e.message + ')'); continue; }
  const v = (data.videos || []).find(x => x.id === videoId);
  if (!v) continue; // video not present in this snapshot (published later / pruned)
  if (v.title) title = v.title;
  // fractional day index: AM -> .0, PM -> .5 from an epoch day number
  const dayNum = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 86400000);
  series.push({ tag: date + '-' + half, date, half, t: dayNum + (half === 'PM' ? 0.5 : 0), views: v.views || 0 });
}
if (series.length < 2) fail('need at least 2 snapshots containing ' + videoId + ' (found ' + series.length + ').');

// per-interval deltas + daily rate
for (let i = 1; i < series.length; i++) {
  const dv = series[i].views - series[i - 1].views;
  const dt = series[i].t - series[i - 1].t; // in days (0.5 typical)
  series[i].delta = dv;
  series[i].dt = dt;
  series[i].rate = dt > 0 ? dv / dt : 0; // views/day
}

// ---- baseline ------------------------------------------------------------
// Robust organic rate = median of pre-spike daily rates. "Pre-spike" is
// everything before --from, or before the first auto-detected spike.
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

let baseline = opts.baseline;
let autoFrom = opts.from;
if (baseline === undefined || !autoFrom) {
  // provisional baseline from the median of the lower half of all rates
  const rates = series.slice(1).map(s => s.rate);
  const provisional = median(rates.filter(r => r <= median(rates)));
  const trigger = Math.max(provisional * opts.threshold, provisional + 50);
  // We want the MOST RECENT campaign, not an old launch tail. Scan from the end
  // backward to find the latest contiguous block of above-trigger intervals,
  // then take the start of that block as the run start.
  let spikeIdx = -1;
  for (let i = series.length - 1; i >= 1; i--) {
    if (series[i].rate > trigger) { spikeIdx = i; }       // remember earliest in this block
    else if (spikeIdx !== -1) break;                       // block ended — stop
  }
  if (!autoFrom && spikeIdx > 0) autoFrom = series[spikeIdx].date;
  if (baseline === undefined) {
    const preRates = series.slice(1)
      .filter(s => !autoFrom || s.date < autoFrom)
      .map(s => s.rate);
    baseline = preRates.length ? median(preRates) : provisional;
  }
}
const fromDate = autoFrom || series[1].date;
const toDate = opts.to || series[series.length - 1].date;

// ---- attribute -----------------------------------------------------------
let observed = 0, organicExpected = 0, days = 0;
const runRows = [];
for (let i = 1; i < series.length; i++) {
  const s = series[i];
  if (s.date < fromDate || s.date > toDate) continue;
  observed += s.delta;
  organicExpected += baseline * s.dt;
  days += s.dt;
  runRows.push(s);
}
const adDriven = Math.round(observed - organicExpected);

// ---- report --------------------------------------------------------------
const fmt = n => Number(n).toLocaleString('en-US');
console.log('\nVideo:    ' + (title || '(title unknown)') + '  [' + videoId + ']');
console.log('Snapshots: ' + series.length + '  (' + series[0].tag + ' → ' + series[series.length - 1].tag + ')');

if (!opts.quiet) {
  console.log('\n  snapshot          views        Δ     Δ/day' + '   ' );
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    const inRun = i > 0 && s.date >= fromDate && s.date <= toDate;
    const d = i === 0 ? '' : (s.delta >= 0 ? '+' : '') + fmt(s.delta);
    const r = i === 0 ? '' : (Math.round(s.rate)).toLocaleString('en-US');
    console.log('  ' + s.tag.padEnd(15) + fmt(s.views).padStart(9) + d.padStart(10) + r.padStart(9) + (inRun ? '  ◀ run' : ''));
  }
}

console.log('\n--- Ad impact -------------------------------------------------');
console.log('Organic baseline:   ' + fmt(Math.round(baseline)) + ' views/day' + (opts.baseline !== undefined ? ' (manual)' : ' (auto)'));
console.log('Run window:         ' + fromDate + '  →  ' + toDate + '   (' + days + ' days observed)');
console.log('Views gained:       ' + fmt(observed) + ' total');
console.log('Expected organic:   ' + fmt(Math.round(organicExpected)));
console.log('AD-DRIVEN VIEWS:    ' + fmt(adDriven) + (toDate === series[series.length - 1].date ? '   (run may be ongoing — latest snapshot)' : ''));
console.log('---------------------------------------------------------------\n');

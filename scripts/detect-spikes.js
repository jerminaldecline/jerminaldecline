#!/usr/bin/env node
/*
 * detect-spikes.js — find videos with an "ad-generated" view-velocity pattern.
 *
 * The signature of a promoted (vs organic) view burst on a video that is past
 * its launch is: a long flat baseline, then a sharp sustained jump. This script
 * reconstructs each video's view history from the twice-daily snapshot archive
 * (sibling jerminaldecline-snapshots repo), flags videos that match the pattern,
 * and writes a compact public/view-spikes.json for the site to render later.
 *
 * IMPORTANT — what this does NOT claim: a spike here is an *anomaly*, not a
 * proven paid ad. Possible causes are an undisclosed ad campaign, off-platform
 * paid promotion, or a viral/news resurface. The output labels accordingly and
 * carries a `newsLikely` hint when the video's topic matches an active story.
 *
 * Hard filters (learned empirically — these kill the false positives):
 *   - Long-form only. Shorts resurface via the Shorts feed constantly.
 *   - Genuinely aged: published >= MIN_AGE_DAYS before the spike (kills the
 *     organic launch-decay tail of recently published videos).
 *   - Flat baseline (<= MAX_BASELINE/day) then an elevated run.
 *   - Excludes videos already in ad-videos.json (those are known/expected).
 *   - Event excess (views above baseline) >= MIN_EXCESS.
 *
 * Confidence is graded, not gated: a single elevated snapshot is "emerging";
 * two or more consecutive is "sustained". (A real run we catch on day one only
 * has one point — we don't want to drop it, just mark it lower-confidence.)
 *
 * Usage:  node scripts/detect-spikes.js [--out <path>] [--quiet]
 *         [--min-excess N] [--min-age-days N] [--max-baseline N]
 * Env:    SNAPSHOTS_DIR  (default: ../../jerminaldecline-snapshots/snapshots)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- tunables ----
const P = {
  MIN_AGE_DAYS: 7,     // video must be this old (days) at the spike start
  MAX_BASELINE: 150,   // organic floor must be at/under this (views/day)
  ELEV_RATIO: 6,       // an interval is "elevated" at >= ELEV_RATIO x baseline
  ELEV_FLOOR: 300,     // ...but at least this many views/day
  MIN_EXCESS: 500,     // event must add at least this many views above baseline
};
let OUT = path.join(__dirname, '..', 'public', 'view-spikes.json');
let quiet = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') OUT = argv[++i];
  else if (a === '--quiet') quiet = true;
  else if (a === '--min-excess') P.MIN_EXCESS = +argv[++i];
  else if (a === '--min-age-days') P.MIN_AGE_DAYS = +argv[++i];
  else if (a === '--max-baseline') P.MAX_BASELINE = +argv[++i];
  else { console.error('unknown arg ' + a); process.exit(1); }
}

const SNAP_DIR = process.env.SNAPSHOTS_DIR
  || path.join(__dirname, '..', '..', 'jerminaldecline-snapshots', 'snapshots');
const PUB = path.join(__dirname, '..', 'public');
const ADS = path.join(PUB, 'ad-videos.json');

function ord(date) { // YYYY-MM-DD -> ordinal day number
  const [y, m, d] = date.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- load snapshots ----
if (!fs.existsSync(SNAP_DIR)) { console.error('snapshots dir not found: ' + SNAP_DIR); process.exit(1); }
const files = fs.readdirSync(SNAP_DIR).filter(f => /^\d{4}-\d{2}-\d{2}-(AM|PM)\.json\.gz$/.test(f)).sort();
if (files.length < 6) { console.error('need >=6 snapshots, found ' + files.length); process.exit(1); }

const snaps = [];           // { t, views: Map(id->views) }
const meta = new Map();     // id -> latest video object
const channels = {};        // id -> title
for (const f of files) {
  const [, date, half] = f.match(/^(\d{4}-\d{2}-\d{2})-(AM|PM)\.json\.gz$/);
  let d;
  try { d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP_DIR, f))).toString('utf8')); }
  catch (e) { console.error('skip ' + f + ': ' + e.message); continue; }
  Object.entries(d.channels || {}).forEach(([cid, c]) => { channels[cid] = c.title || cid; });
  const views = new Map();
  for (const v of d.videos || []) { views.set(v.id, v.views || 0); meta.set(v.id, v); }
  snaps.push({ tag: date + '-' + half, t: ord(date) + (half === 'PM' ? 0.5 : 0), date, views });
}
const windowFrom = snaps[0], windowTo = snaps[snaps.length - 1];

// ---- reference data ----
const flagged = new Set();
try {
  const aj = JSON.parse(fs.readFileSync(ADS, 'utf8'));
  Object.values(aj.channels || {}).forEach(c => (c.videoIds || []).forEach(id => flagged.add(id)));
} catch (e) { console.error('warn: could not read ad-videos.json (' + e.message + ')'); }

// best-effort topic / active-story data for the newsLikely hint
let topicOf = {}, topics = {}, activeTerms = new Set();
try { topicOf = (JSON.parse(fs.readFileSync(path.join(PUB, 'topic-tags.json'), 'utf8')).tags) || {}; } catch (e) {}
try { topics = JSON.parse(fs.readFileSync(path.join(PUB, 'topics.json'), 'utf8')) || {}; } catch (e) {}
try {
  const tk = JSON.parse(fs.readFileSync(path.join(PUB, 'topic-trackers.json'), 'utf8'));
  for (const t of (tk.trackers || [])) {
    // only count clusters that are actually spiking right now
    if ((t.detectorMeta?.recentSaturation || 0) >= 0.15) activeTerms.add(t.termId);
  }
} catch (e) {}

// ---- analysis ----
function analyse(id) {
  const pts = [];
  for (const s of snaps) if (s.views.has(id)) pts.push({ t: s.t, tag: s.tag, v: s.views.get(id) });
  if (pts.length < 6) return null;
  const R = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t; if (dt <= 0) continue;
    R.push({ t0: pts[i - 1].t, dv: pts[i].v - pts[i - 1].v, dt, rate: (pts[i].v - pts[i - 1].v) / dt });
  }
  if (!R.length) return null;
  const baseline = median(R.map(r => r.rate).sort((a, b) => a - b).slice(0, Math.max(1, R.length >> 1)));
  const elev = Math.max(baseline * P.ELEV_RATIO, P.ELEV_FLOOR);
  // most recent maximal run of consecutive elevated intervals
  let end = -1;
  for (let i = R.length - 1; i >= 0; i--) { if (R[i].rate >= elev) { end = i; break; } }
  if (end === -1) return { baseline, pts, R, event: null };
  let start = end;
  while (start - 1 >= 0 && R[start - 1].rate >= elev) start--;
  const ev = R.slice(start, end + 1);
  const excess = ev.reduce((s, r) => s + (r.dv - baseline * r.dt), 0);
  const peak = Math.max(...ev.map(r => r.rate));
  return {
    baseline, pts, R,
    event: { spikeStart: R[start].t0, n: ev.length, excess, peak,
             ratio: peak / Math.max(baseline, 1) },
  };
}

function build(id, a) {
  const v = meta.get(id), ev = a.event;
  const ageAtSpike = ev.spikeStart - ord(v.publishedAt.slice(0, 10));
  const topicId = topicOf[id];
  const newsLikely = !!(topicId && activeTerms.has(topicId));
  return {
    id, title: v.title, channelId: v.channelId, channel: channels[v.channelId] || v.channelId,
    publishedAt: v.publishedAt, ageDaysAtSpike: ageAtSpike,
    baselinePerDay: Math.round(a.baseline),
    peakPerDay: Math.round(ev.peak), ratio: +ev.ratio.toFixed(1),
    spikeStartDate: snaps.find(s => s.t === ev.spikeStart)?.tag || null,
    elevatedSnapshots: ev.n, status: ev.n >= 2 ? 'sustained' : 'emerging',
    estPromotedViews: Math.round(ev.excess),
    topic: topicId ? (topics[topicId]?.name || topicId) : null,
    newsLikely,
    series: a.pts.map(p => [p.tag, p.v]),
  };
}

const eligible = (id) => {
  const v = meta.get(id);
  return v && !v.isShort && !flagged.has(id) && v.publishedAt;
};
function qualifies(id, a) {
  if (!a || !a.event) return false;
  if (a.baseline > P.MAX_BASELINE) return false;
  if (a.event.excess < P.MIN_EXCESS) return false;
  const v = meta.get(id);
  const ageAtSpike = a.event.spikeStart - ord(v.publishedAt.slice(0, 10));
  return ageAtSpike >= P.MIN_AGE_DAYS;
}

const spikes = [];
for (const id of meta.keys()) {
  if (!eligible(id)) continue;
  const a = analyse(id);
  if (qualifies(id, a)) spikes.push(build(id, a));
}
spikes.sort((x, y) => y.estPromotedViews - x.estPromotedViews);

// validation: known ads that also show a spike in-window (long-form, aged)
const knownAdSpikes = [];
for (const id of flagged) {
  const v = meta.get(id);
  if (!v || v.isShort || !v.publishedAt) continue;
  const a = analyse(id);
  if (a && a.event && a.event.excess >= P.MIN_EXCESS &&
      (a.event.spikeStart - ord(v.publishedAt.slice(0, 10))) >= P.MIN_AGE_DAYS) {
    knownAdSpikes.push({ id, title: v.title, estPromotedViews: Math.round(a.event.excess),
                         spikeStartDate: snaps.find(s => s.t === a.event.spikeStart)?.tag || null });
  }
}
knownAdSpikes.sort((x, y) => y.estPromotedViews - x.estPromotedViews);

const out = {
  // No _generated timestamp on purpose: it would make this file differ on every
  // run and produce empty "refresh" commits. window.to (latest snapshot) is the
  // freshness indicator, and git history records when it actually changed.
  _note: 'Anomalous view-velocity spikes on aged long-form videos NOT in ad-videos.json. A spike is an anomaly (possible undisclosed ad, off-platform promotion, or news/viral resurface), NOT a confirmed paid ad.',
  window: { from: windowFrom.tag, to: windowTo.tag, snapshots: snaps.length },
  params: P,
  knownAdSpikes,   // for reference/validation only
  spikes,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

if (!quiet) {
  const fmt = n => Number(n).toLocaleString('en-US');
  console.log('Window ' + windowFrom.tag + ' -> ' + windowTo.tag + '  (' + snaps.length + ' snapshots)');
  console.log('Validation — known ads that spiked in-window: ' + knownAdSpikes.map(k => k.title + ' (' + fmt(k.estPromotedViews) + ')').join('; ') || '(none)');
  console.log('\nFLAGGED unexplained spikes: ' + spikes.length);
  for (const s of spikes) {
    console.log('  • ' + s.title.slice(0, 52));
    console.log('    ' + s.channel + ' · pub ' + s.publishedAt.slice(0, 10) + ' (age ' + s.ageDaysAtSpike + 'd) · base ' +
      s.baselinePerDay + '/d → peak ' + fmt(s.peakPerDay) + '/d (x' + s.ratio + ') · ~' + fmt(s.estPromotedViews) +
      ' views · ' + s.status + (s.newsLikely ? ' · ⚠ newsLikely (' + s.topic + ')' : '') + ' · ' + s.id);
  }
  console.log('\nWrote ' + OUT);
}

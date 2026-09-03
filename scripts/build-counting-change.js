#!/usr/bin/env node
// Build the counting-change benchmark series: public/counting-change.json
//
// On 27 Aug 2026 YouTube began counting a long-form view from the first frame
// rather than after roughly 30 seconds. This produces the evidence for that,
// in the form the chart draws: views per upload and likes per upload, BOTH read
// at a matched 24h age, bucketed by publish date and indexed to the pre-change
// median.
//
// Why matched age, and why both series. A raw month-over-month comparison of
// view counts cannot separate "the counting changed" from "the videos were more
// popular". Reading every upload at the same age removes the age confound, and
// carrying likes alongside views removes the popularity one: a genuinely bigger
// video lifts BOTH lines, so the two stay together. Only a change in what counts
// as a view moves them apart. They track within a few points for eleven straight
// buckets and then split, which is the whole argument in one picture.
//
// Never-advertised long-form only. An ad campaign buys views without buying
// likes, which is the same signature as the counting change and would forge it.
//
// NOT wired into CI. This is a historical benchmark of a one-off event, not a
// daily metric, and it needs the full snapshot archive. Regenerate by hand when
// re-measuring the factor:
//     node scripts/build-counting-change.js
//     node scripts/build-counting-change.js --snapshots /path/to/snapshots
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const snapArg = args.includes('--snapshots') ? args[args.indexOf('--snapshots') + 1] : null;
// Same convention as build-daily-views.js so it drops into the same CI step if
// it ever needs to run there.
const SNAP_DIR = path.resolve(snapArg || process.env.SNAPSHOTS_DIR
  || path.join(__dirname, '..', '..', 'jerminaldecline-snapshots', 'snapshots'));
const DEBUT_DIR = path.join(path.dirname(SNAP_DIR), 'debut');
const PUB = path.join(__dirname, '..', 'public');
const OUT = path.join(PUB, 'counting-change.json');

const ONSET = '2026-08-27';   // where the data breaks, not YouTube's announced 24th
const AGE_H = 24;             // matched age every upload is read at
const FROM  = '2026-07-05';   // as far back as the archive supports this read
const CHANNELS = { '@TheQuartering': 'UCfwE_ODI1YTbdjkzuSi1Nag',
                   '@JeremyHambly':  'UCEOtZuVe8emWLKRzJIkzVow' };

const data = JSON.parse(fs.readFileSync(path.join(PUB, 'data.json'), 'utf8'));
let ads = new Set();
try {
  ads = new Set(Object.values(JSON.parse(fs.readFileSync(path.join(PUB, 'ad-videos.json'), 'utf8')).channels)
    .flatMap(c => c.videoIds));
} catch (e) { /* no ad list is fine - it only widens the pool */ }

const meta = new Map();
for (const v of data.videos) {
  if (v.unavailable || v.isShort || ads.has(v.id)) continue;
  if ((v.publishedAt || '').slice(0, 10) < FROM) continue;
  meta.set(v.id, v);
}

// Every (age, views, likes) reading we hold for a tracked video.
const obs = new Map();
const add = (id, ageH, views, likes) => {
  if (!meta.has(id) || !(views > 500)) return;   // sub-500 views is noise at 24h
  if (!obs.has(id)) obs.set(id, []);
  obs.get(id).push({ ageH, views, likes: likes || 0 });
};
const readGz = f => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f))); } catch (e) { return null; } };

if (fs.existsSync(DEBUT_DIR)) {
  for (const f of fs.readdirSync(DEBUT_DIR).filter(x => x.endsWith('.json.gz'))) {
    const j = readGz(path.join(DEBUT_DIR, f));
    if (j) for (const v of (j.videos || [])) if (v.ageH != null) add(v.id, +v.ageH, v.views, v.likes);
  }
}
for (const f of fs.readdirSync(SNAP_DIR).filter(x => x.endsWith('.json.gz') && x.slice(0, 10) >= FROM)) {
  const j = readGz(path.join(SNAP_DIR, f));
  if (!j) continue;
  const t = Date.parse((j.meta && j.meta.lastUpdated) || (f.slice(0, 10) + 'T02:00:00Z'));
  for (const v of j.videos) {
    const m = meta.get(v.id);
    if (m) add(v.id, (t - Date.parse(m.publishedAt)) / 3600000, v.views, v.likes);
  }
}

// Linear interpolation between the readings that bracket the target age.
function at(id, H) {
  const p = (obs.get(id) || []).slice().sort((a, b) => a.ageH - b.ageH);
  let lo = null, hi = null;
  for (const x of p) { if (x.ageH <= H) lo = x; if (x.ageH >= H && !hi) hi = x; }
  if (!lo || !hi) return null;
  if (hi.ageH === lo.ageH) return lo;
  const w = (H - lo.ageH) / (hi.ageH - lo.ageH);
  return { views: lo.views + (hi.views - lo.views) * w, likes: lo.likes + (hi.likes - lo.likes) * w };
}
const med = a => { const s = [...a].sort((x, y) => x - y), n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

const out = {
  _note: 'Views and likes per upload, both read at ' + AGE_H + 'h old. Long-form, never advertised. '
       + 'Indexed to the pre-change median = 100. Built by scripts/build-counting-change.js.',
  onset: ONSET, ageHours: AGE_H, from: FROM,
  generated: new Date().toISOString().slice(0, 19) + 'Z',
  channels: {},
};

for (const [handle, cid] of Object.entries(CHANNELS)) {
  const pts = [];
  for (const [id, m] of meta) {
    if (m.channelId !== cid) continue;
    const s = at(id, AGE_H);
    if (s && s.views > 500) pts.push({ d: m.publishedAt.slice(0, 10), vw: s.views, lk: s.likes });
  }
  if (pts.length < 20) continue;
  pts.sort((a, b) => a.d.localeCompare(b.d));

  // Baseline excludes 24-26 Aug: the change was announced on the 24th, and
  // leaving those three days in the baseline would blunt the step if the real
  // onset ever turns out to be the announced date after all.
  const pre = pts.filter(p => p.d < '2026-08-24');
  const baseV = med(pre.map(p => p.vw)), baseL = med(pre.map(p => p.lk));

  // Five-day buckets, with the onset forced to be a boundary. Without that the
  // bucket spanning the 27th mixes both regimes and smears the step into a ramp.
  const edges = [];
  for (let d = new Date(FROM + 'T00:00:00Z'); d < new Date(); d.setUTCDate(d.getUTCDate() + 5)) {
    edges.push(d.toISOString().slice(0, 10));
  }
  if (!edges.includes(ONSET)) edges.push(ONSET);
  edges.sort();

  const series = [];
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i], b = edges[i + 1] || '9999-12-31';
    const bucket = pts.filter(p => p.d >= a && p.d < b);
    if (bucket.length < 3) continue;      // a median of one or two is not a point
    series.push({ from: a, n: bucket.length,
      views: Math.round(100 * med(bucket.map(p => p.vw)) / baseV),
      likes: Math.round(100 * med(bucket.map(p => p.lk)) / baseL) });
  }

  const post = pts.filter(p => p.d >= ONSET);
  // Median of the PER-VIDEO rates, not a ratio of aggregate medians. This is the
  // same statistic the site's factor is measured with, and mixing the two would
  // publish a headline number that disagrees with the one in the tooltip.
  const rateOf = arr => med(arr.map(p => 1000 * p.lk / p.vw));
  const rateBefore = rateOf(pre);
  const rateAfter = rateOf(post);
  out.channels[handle] = {
    n: pts.length, nPost: post.length,
    rateBefore: +rateBefore.toFixed(1), rateAfter: +rateAfter.toFixed(1),
    factor: +(rateBefore / rateAfter).toFixed(2),
    series,
  };
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log('Wrote %s', path.relative(process.cwd(), OUT));
for (const [h, c] of Object.entries(out.channels)) {
  console.log('  %s  n=%d (post %d)  like rate %s -> %s per 1k  factor %sx',
    h, c.n, c.nPost, c.rateBefore, c.rateAfter, c.factor);
}

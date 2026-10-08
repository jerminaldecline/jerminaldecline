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
// Like-rate threshold for the distribution view, in percent. Chosen by maximum
// separation rather than by taste: below 6.5% sits 1 of 168 pre-change uploads
// and 22 of 24 post-change ones. A rounder 4% would catch only 5 of the 24 and
// understate the split; 8% starts pulling in real pre-change videos.
const LOW_RATE_PCT = 6.5;
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

  // Per-upload like rates, for the distribution strip. Two small arrays rather
  // than a histogram, so the chart can bin them however it likes later.
  const rate = p => 100 * p.lk / p.vw;
  const distPre = pre.map(rate).map(r => +r.toFixed(2)).sort((a, b) => a - b);
  const post = pts.filter(p => p.d >= ONSET);
  const postViews = post.reduce((a, p) => a + p.vw, 0);
  const distPost = post.map(rate).map(r => +r.toFixed(2)).sort((a, b) => a - b);
  // Median of the PER-VIDEO rates, not a ratio of aggregate medians. This is the
  // same statistic the site's factor is measured with, and mixing the two would
  // publish a headline number that disagrees with the one in the tooltip.
  const rateOf = arr => med(arr.map(p => 1000 * p.lk / p.vw));
  const rateBefore = rateOf(pre);
  const rateAfter = rateOf(post);
  out.channels[handle] = {
    n: pts.length, nPost: post.length,
    lowRatePct: LOW_RATE_PCT,
    postViews: Math.round(postViews),
    dist: { pre: distPre, post: distPost,
            lowPre: distPre.filter(r => r < LOW_RATE_PCT).length,
            lowPost: distPost.filter(r => r < LOW_RATE_PCT).length },
    rateBefore: +rateBefore.toFixed(1), rateAfter: +rateAfter.toFixed(1),
    factor: +(rateBefore / rateAfter).toFixed(2),
    series,
  };

  // ---- the same question asked other ways ---------------------------------
  // A bootstrap interval only covers "which videos happened to be published".
  // It says nothing about the choices made in the analysis itself: which
  // average, what age to read at, how much history counts as the baseline,
  // whether to allow for a gradual drift in how often people like. Each check
  // below changes exactly one of those and re-measures. The published range is
  // then widened to contain every one of them (see the site section).
  //
  // Why this exists: a deep check on 2026-10-04 found the like rate wanders by
  // about 12% from month to month in ordinary times, so a comparison confined
  // to the weeks nearest the change, or one that allows a drift, reads a little
  // lower (1.94-2.03) than the full before-and-after figure (2.07). None of
  // them is distinguishable from it statistically, but an honest range should
  // cover them.
  {
    const rk = p => 1000 * p.lk / p.vw;
    const fac = (a, b) => (a.length >= 15 && b.length >= 15) ? med(a.map(rk)) / med(b.map(rk)) : null;
    const dn = d => Date.parse(d + 'T00:00:00Z') / 864e5, on = dn(ONSET);
    const mean = a => a.reduce((t, x) => t + x, 0) / a.length;
    const sum = (a, k) => a.reduce((t, p) => t + p[k], 0);
    const near = W => fac(pre.filter(p => dn(p.d) >= on - 3 - W), post.filter(p => dn(p.d) < on + W));
    const atAge = H => {
      const o = [];
      for (const [id, m] of meta) {
        if (m.channelId !== cid) continue;
        const r = at(id, H);
        if (r && r.views > 500) o.push({ d: m.publishedAt.slice(0, 10), vw: r.views, lk: r.likes });
      }
      return fac(o.filter(p => p.d < '2026-08-24'), o.filter(p => p.d >= ONSET));
    };
    // One gradual drift in the like rate throughout, plus a step at the change.
    const drift = () => {
      const all = pre.concat(post);
      const X = all.map(p => [1, dn(p.d) - on, p.d >= ONSET ? 1 : 0]), y = all.map(p => Math.log(rk(p)));
      const A = [0, 1, 2].map(a => [0, 1, 2].map(b => X.reduce((t, r) => t + r[a] * r[b], 0))
        .concat([X.reduce((t, r, i) => t + r[a] * y[i], 0)]));
      for (let c = 0; c < 3; c++) {
        let p = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
        [A[c], A[p]] = [A[p], A[c]];
        for (let r = 0; r < 3; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let j = c; j < 4; j++) A[r][j] -= f * A[c][j]; }
      }
      return Math.exp(-A[2][3] / A[2][2]);
    };
    const enough = pre.length >= 15 && post.length >= 15;
    out.channels[handle].checks = [
      ['the average video rather than the middle one', enough ? Math.exp(mean(pre.map(p => Math.log(rk(p)))) - mean(post.map(p => Math.log(rk(p))))) : null],
      ['all likes divided by all views', enough ? (sum(pre, 'lk') / sum(pre, 'vw')) / (sum(post, 'lk') / sum(post, 'vw')) : null],
      ['only the two weeks either side of the change', near(14)],
      ['only the four weeks either side of the change', near(28)],
      ['only the last 30 days as the baseline', fac(pre.filter(p => dn(p.d) >= on - 33), post)],
      ['allowing for a gradual drift in how often people like', enough ? drift() : null],
      ['reading each video at 12 hours old', atAge(12)],
      ['reading each video at 48 hours old', atAge(48)],
      ['reading each video at 72 hours old', atAge(72)],
    ].filter(k => k[1] != null && isFinite(k[1])).map(k => ({ label: k[0], factor: +k[1].toFixed(2) }));
  }
}

// ---- the number the site divides by ----------------------------------------
// BENCHMARK CHANNEL, not a pooled figure (changed 2026-10-03). The site's factor
// is the main channel's own measurement: one channel, one calculation, nothing
// to weight and nothing to explain about weighting. The other channel is
// reported beside it as an independent check - the rule change was
// platform-wide, so a second audience landing on the same multiple is the
// evidence that the factor measures the rule and not the channel.
//
// Pooling them view-weighted (the previous method) gave 2.10 against 2.08 on the
// day this changed, so the choice moves no figure by more than 1%. `pooled`
// keeps that number on file so the two can always be compared.
//
// Every channel gets its own bootstrapped 95% interval, resampling uploads
// within the channel, so the page can draw the two side by side.
//
// SHIPS WITH THE PAGE. index.html prints `site` in its caption and divides by
// the constants VCC_MID / VCC_FACTOR, which must be set to match. Committing
// this file without the page that reads it makes the two disagree.
const BENCHMARK = '@TheQuartering';
const chans = Object.values(out.channels);
if (chans.length) {
  let seed = 20260907;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const medOf = a => { const q = [...a].sort((x, y) => x - y), n = q.length;
    return n ? (n % 2 ? q[(n - 1) / 2] : (q[n / 2 - 1] + q[n / 2]) / 2) : NaN; };
  const B = 4000;
  const wsum = chans.reduce((a, c) => a + c.postViews, 0) || 1;
  const pooledBoot = new Array(B).fill(0);
  for (const c of chans) {
    const arr = [];
    for (let b = 0; b < B; b++) {
      const pre = Array.from({ length: c.dist.pre.length }, () => pick(c.dist.pre));
      const po  = Array.from({ length: c.dist.post.length }, () => pick(c.dist.post));
      const mp = medOf(po);
      const f = mp > 0 ? medOf(pre) / mp : c.factor;
      arr.push(f);
      pooledBoot[b] += c.postViews * f / wsum;
    }
    arr.sort((x, y) => x - y);
    // sampleLow/High: the bootstrapped 95% interval on its own.
    // low/high: that interval widened to take in every alternative method, so
    // the published range answers "what could the figure be" and not only
    // "how much would it move with a different draw of videos".
    c.sampleLow = +arr[Math.floor(B * 0.025)].toFixed(2);
    c.sampleHigh = +arr[Math.floor(B * 0.975)].toFixed(2);
    const alt = (c.checks || []).map(k => k.factor);
    c.low = +Math.min(c.sampleLow, ...alt).toFixed(2);
    c.high = +Math.max(c.sampleHigh, ...alt).toFixed(2);
  }
  pooledBoot.sort((x, y) => x - y);
  out.pooled = {
    factor: +(chans.reduce((a, c) => a + c.postViews * c.factor, 0) / wsum).toFixed(2),
    low: +pooledBoot[Math.floor(B * 0.025)].toFixed(2),
    high: +pooledBoot[Math.floor(B * 0.975)].toFixed(2),
    nPost: chans.reduce((a, c) => a + c.nPost, 0),
  };
  const bmHandle = out.channels[BENCHMARK] ? BENCHMARK : Object.keys(out.channels)[0];
  const bm = out.channels[bmHandle];
  const alts = (bm.checks || []).map(k => k.factor);
  out.site = { channel: bmHandle, factor: bm.factor, low: bm.low, high: bm.high, nPost: bm.nPost,
    sampleLow: bm.sampleLow, sampleHigh: bm.sampleHigh,
    checks: alts.length ? { n: alts.length, min: Math.min(...alts), max: Math.max(...alts) } : null };
}

fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log('Wrote %s', path.relative(process.cwd(), OUT));
if (out.site) {
  console.log('  SITE FACTOR %s  (range %s-%s, n=%d post-change uploads, benchmark %s)',
    out.site.factor, out.site.low, out.site.high, out.site.nPost, out.site.channel);
  console.log('    sampling interval alone: %s-%s', out.site.sampleLow, out.site.sampleHigh);
  for (const k of (out.channels[out.site.channel].checks || [])) console.log('    %s  %s', k.factor.toFixed(2), k.label);
  console.log('  pooled across channels, for reference: %s  (95%% %s-%s, n=%d)',
    out.pooled.factor, out.pooled.low, out.pooled.high, out.pooled.nPost);
  console.log('    -> set VCC_MID and VCC_FACTOR in public/index.html to match\n');
}
for (const [h, c] of Object.entries(out.channels)) {
  console.log('  %s  n=%d (post %d)  like rate %s -> %s per 1k  factor %sx  (95%% %s-%s)',
    h, c.n, c.nPost, c.rateBefore, c.rateAfter, c.factor, c.low, c.high);
  console.log('      below %s%%: %d of %d before, %d of %d after',
    c.lowRatePct, c.dist.lowPre, c.dist.pre.length, c.dist.lowPost, c.dist.post.length);
}

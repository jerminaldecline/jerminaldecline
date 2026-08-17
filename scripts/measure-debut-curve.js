#!/usr/bin/env node
/**
 * Second, independent estimate of YouTube's 24 Aug 2026 view-counting change,
 * measured on NEW UPLOADS from the hourly debut samples.
 *
 * measure-viewcount-change.js measures the step on the DORMANT BACK CATALOGUE —
 * old videos living on search and suggested traffic. This measures it on videos
 * in their first day, which live on subscription and home-feed traffic. If the
 * change is partly about feed autoplay now counting, those two surfaces will not
 * move by the same amount, and the gap between the estimates is itself the
 * finding. Neither is a substitute for the other.
 *
 * TWO SIGNALS, not one:
 *
 *   LEVEL — median views at 18h, before vs after. That ratio is the inflation
 *   factor as it applies to new uploads.
 *
 *   SHAPE — how front-loaded the first day is. A view that counts from the first
 *   frame lands the instant someone opens the video, so if the extra views are
 *   people bouncing early the curve should steepen sharply at 1-2h. If the shape
 *   is unchanged and only the level moves, every hour gained proportionally,
 *   which points at a uniform re-count rather than a bounce effect.
 *
 * 18h is the reference age because the sampler follows a video for roughly 24h
 * and coverage past 18h is uneven; every usable video reaches it.
 *
 * Usage:
 *   node scripts/measure-debut-curve.js            # report + write baseline/result
 *   node scripts/measure-debut-curve.js --dry      # report only
 */
const fs = require('fs'), zlib = require('zlib'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SNAP_ROOT = process.env.SNAPSHOTS_DIR
  ? path.dirname(process.env.SNAPSHOTS_DIR)
  : path.join(path.dirname(ROOT), 'jerminaldecline-snapshots');
const DEBUT = path.join(SNAP_ROOT, 'debut');
const CFG = path.join(PUBLIC, 'view-count-change.json');
const TQ = 'UCfwE_ODI1YTbdjkzuSi1Nag';
const REF_H = 18;
const MARKS = [1, 2, 4, 6, 8, 12, 18];
const DRY = process.argv.includes('--dry');

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const CHANGE = cfg.effectiveDate;

if (!fs.existsSync(DEBUT)) { console.error('no debut samples at ' + DEBUT); process.exit(1); }

const byVid = new Map();
for (const f of fs.readdirSync(DEBUT).filter(x => x.endsWith('.json.gz')).sort()) {
  let j; try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DEBUT, f)))); } catch { continue; }
  for (const v of (j.videos || [])) {
    if (v.channelId !== TQ || v.isShort) continue;      // long-form only: Shorts already counted this way
    if (!byVid.has(v.id)) byVid.set(v.id, { id: v.id, pub: v.publishedAt, pts: [] });
    byVid.get(v.id).pts.push({ ageH: v.ageH, views: v.views });
  }
}
// Usable = sampled from early enough, densely enough, and out to the reference age.
const usable = [...byVid.values()].filter(v => {
  const a = v.pts.map(p => p.ageH).sort((x, y) => x - y);
  return a.length >= 8 && a[0] <= 4 && a[a.length - 1] >= REF_H;
});

const at = (v, h) => {
  const p = [...v.pts].sort((a, b) => a.ageH - b.ageH);
  let lo = null, hi = null;
  for (const x of p) { if (x.ageH <= h) lo = x; if (x.ageH >= h && !hi) hi = x; }
  if (!lo || !hi) return null;
  return lo.ageH === hi.ageH ? lo.views
    : lo.views + (hi.views - lo.views) * ((h - lo.ageH) / (hi.ageH - lo.ageH));
};
const med = a => { const s = [...a].sort((x, y) => x - y); const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

const pre = usable.filter(v => v.pub.slice(0, 10) < CHANGE);
const post = usable.filter(v => v.pub.slice(0, 10) >= CHANGE);

function profile(set) {
  if (set.length < 4) return null;
  const level = med(set.map(v => at(v, REF_H)).filter(x => x != null));
  const shape = {};
  for (const h of MARKS) {
    const fr = set.map(v => { const a = at(v, h), b = at(v, REF_H); return (a != null && b) ? a / b : null; })
      .filter(x => x != null);
    if (fr.length >= 4) shape[h] = +med(fr).toFixed(4);
  }
  return { n: set.length, viewsAt18h: Math.round(level), shape };
}
const P = profile(pre), Q = profile(post);

console.log(`debut samples: ${fs.readdirSync(DEBUT).length} files   change date ${CHANGE}`);
console.log(`usable long-form curves: ${usable.length}  (before ${pre.length}, after ${post.length})\n`);
if (!P) { console.log('Not enough pre-change videos yet.'); process.exit(0); }

const row = (label, p) => label.padEnd(8) + MARKS.map(h =>
  (p.shape[h] == null ? '  —  ' : (p.shape[h] * 100).toFixed(0).padStart(4) + '%')).join(' ');
console.log('           ' + MARKS.map(h => (h + 'h').padStart(5)).join(' '));
console.log(row('before', P) + `     median ${P.viewsAt18h.toLocaleString()} views @18h  (n=${P.n})`);
if (Q) console.log(row('after', Q) + `     median ${Q.viewsAt18h.toLocaleString()} views @18h  (n=${Q.n})`);

cfg.debutCurve = { referenceHour: REF_H, before: P, after: Q || null };

if (Q) {
  const level = Q.viewsAt18h / P.viewsAt18h;
  // Front-loading: how much more of the first day has landed by 2h. Bounces
  // arrive instantly, so a real first-frame effect should show up here.
  const fl = (Q.shape[2] != null && P.shape[2] != null) ? Q.shape[2] - P.shape[2] : null;
  console.log(`\n  LEVEL  new uploads ${((level - 1) * 100).toFixed(1)}%  => factor ${level.toFixed(3)}`);
  if (fl != null) {
    console.log(`  SHAPE  share of day-one views landed by 2h: ${(P.shape[2]*100).toFixed(0)}% -> ${(Q.shape[2]*100).toFixed(0)}%  (${fl >= 0 ? '+' : ''}${(fl*100).toFixed(0)}pts)`);
    console.log(fl > 0.05
      ? '         steeper start — consistent with plays that end quickly now counting'
      : '         shape roughly unchanged — a uniform re-count rather than a bounce effect');
  }
  cfg.debutCurve.levelRatio = +level.toFixed(4);
  cfg.debutCurve.frontLoadShift = fl == null ? null : +fl.toFixed(4);
  if (P.n < 8 || Q.n < 8) console.log('  NOTE: fewer than 8 videos either side — treat as indicative.');
} else {
  console.log('\n  Baseline recorded. Re-run after the change for the comparison.');
}

if (DRY) { console.log('\n--dry: nothing written.'); process.exit(0); }
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');
console.log(`\nwrote ${path.relative(ROOT, CFG)}`);

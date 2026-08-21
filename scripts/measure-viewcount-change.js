#!/usr/bin/env node
/**
 * Measure YouTube's 24 Aug 2026 view-counting change and write the calibration
 * factor into public/view-count-change.json.
 *
 * From that date a view counts the moment a video begins to play, with no
 * minimum watch time. Long-form previously needed roughly 30 seconds. Every view
 * figure that spans the date is therefore a blend of two metrics, and the
 * revenue estimate (views x RPM) overstates from that day on, because YouTube
 * pays on "engaged views" — the old bar — not the new public count.
 *
 * WHY NOT A SIMPLE BEFORE/AFTER AVERAGE: a channel's daily views are dominated
 * by whatever it uploaded recently, so a whole-channel average conflates the
 * counting change with upload cadence — and August 2026 also has the view and
 * subscriber anomaly running through it. Two controls remove that:
 *
 *   DORMANT, NEVER-ADVERTISED BACK CATALOGUE. Old videos are in flat decay, and
 *   nothing about them changes on 24 Aug except how their views are counted.
 *   Advertised videos are excluded outright: his Walmart re-runs pushed 36,640
 *   views a day through the back catalogue in mid-August against a ~1,100
 *   baseline, which would swamp the signal.
 *
 *   SHORTS AS A CONTROL. Shorts have counted this way since 31 Mar 2025, so they
 *   should show NO step. Dividing the long-form ratio by the Shorts ratio cancels
 *   any channel-wide drift that happens to coincide with the date.
 *
 * The measured noise floor is +/-17% day to day. Resampling the real spread puts
 * the 95% interval on the FACTOR at +/-16% over 7 days either side, +/-11% over
 * 14 and +/-8% over 28 - so a 20-30% step is clear at two weeks but NOT at one.
 * No percentage is published until it clears its own window floor.
 *
 * Usage:  node scripts/measure-viewcount-change.js [--window 14] [--dry]
 */
const fs = require('fs'), zlib = require('zlib'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SNAP = process.env.SNAPSHOTS_DIR
  || path.join(path.dirname(ROOT), 'jerminaldecline-snapshots', 'snapshots');
const CFG = path.join(PUBLIC, 'view-count-change.json');
const TQ = 'UCfwE_ODI1YTbdjkzuSi1Nag';

const argv = process.argv.slice(2);
const WINDOW = +(argv[argv.indexOf('--window') + 1]) || 14;
const DRY = argv.includes('--dry');

const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const CHANGE = cfg.effectiveDate;
const data = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'data.json'), 'utf8'));
const adIds = new Set(Object.values(JSON.parse(fs.readFileSync(path.join(PUBLIC, 'ad-videos.json'), 'utf8')).channels)
  .flatMap(c => c.videoIds));

const shift = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const PRE_FROM = shift(CHANGE, -WINDOW), POST_TO = shift(CHANGE, WINDOW - 1);

// Dormant = published comfortably before the window opens, so it is in flat decay
// rather than still riding its launch curve.
const DORMANT_BEFORE = shift(PRE_FROM, -21);
const pool = data.videos.filter(v => v.channelId === TQ && !v.unavailable
  && v.publishedAt.slice(0, 10) < DORMANT_BEFORE && !adIds.has(v.id));
const isShort = new Map(pool.map(v => [v.id, !!v.isShort]));

const files = fs.readdirSync(SNAP).filter(f => /-AM\.json\.gz$/.test(f)).sort();
const series = [];
for (const f of files) {
  const day = f.slice(0, 10);
  if (day < shift(PRE_FROM, -1) || day > shift(POST_TO, 1)) continue;
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP, f))));
  const m = new Map(j.videos.map(v => [v.id, v.views || 0]));
  let L = 0, S = 0, nL = 0, nS = 0;
  for (const v of pool) {
    if (!m.has(v.id)) continue;
    if (isShort.get(v.id)) { S += m.get(v.id); nS++; } else { L += m.get(v.id); nL++; }
  }
  series.push({ day, L, S, nL, nS });
}

// Day-over-day gains, skipping days where catalogue membership moved (a deletion
// mid-window would otherwise read as a negative day).
const gains = [];
for (let i = 1; i < series.length; i++) {
  const a = series[i - 1], b = series[i];
  if (a.nL !== b.nL || a.nS !== b.nS) continue;
  gains.push({ day: b.day, L: b.L - a.L, S: b.S - a.S });
}
const med = a => { const s = [...a].sort((x, y) => x - y); const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const slice = (from, to, key) => med(gains.filter(g => g.day >= from && g.day <= to)
  .map(g => g[key]).filter(x => x > 0));

// How many usable days actually exist each side, TRUNCATED TO WHOLE WEEKS.
// Two separate reasons. The daily series has a weekday cycle, so an uneven slice
// of it injects bias that looks exactly like a real step. And the nominal
// --window said nothing about how much data had arrived: run on 25 Aug with one
// post-change day, the old code still recorded windowDays: 14.
const daysIn = (from, to, key) => gains.filter(g => g.day >= from && g.day <= to && g[key] > 0).length;
const availPost = daysIn(CHANGE, POST_TO, 'L');
const availPre  = daysIn(PRE_FROM, shift(CHANGE, -1), 'L');
const WEEKS  = Math.floor(Math.min(availPre, availPost) / 7);
const USABLE = WEEKS * 7;

console.log(`change date ${CHANGE}   requested window +/-${WINDOW}d`);
console.log(`days available: ${availPre} pre, ${availPost} post -> using ${USABLE} each side (${WEEKS} whole week(s))`);

if (USABLE < 7) {
  console.log('');
  console.log('Less than a whole week either side. Nothing written - the site keeps showing');
  console.log('the notice with no percentage, which is the correct state until data exists.');
  process.exit(0);
}

const PRE_A = shift(CHANGE, -USABLE), PRE_B = shift(CHANGE, -1);
const POST_B = shift(CHANGE, USABLE - 1);

const preL = slice(PRE_A, PRE_B, 'L'), postL = slice(CHANGE, POST_B, 'L');
const preS = slice(PRE_A, PRE_B, 'S'), postS = slice(CHANGE, POST_B, 'S');

console.log(`control pool: ${pool.filter(v => !v.isShort).length} long-form, ${pool.filter(v => v.isShort).length} shorts (dormant, never advertised)`);
console.log(`  long-form  ${preL == null ? '-' : Math.round(preL)} -> ${postL == null ? '-' : Math.round(postL)} views/day`);
console.log(`  shorts     ${preS == null ? '-' : Math.round(preS)} -> ${postS == null ? '-' : Math.round(postS)} views/day  (control: expect no step)`);

if (preL == null || postL == null) {
  console.log('');
  console.log('Not enough data either side of the change yet - nothing written.');
  process.exit(0);
}
const rawRatio = postL / preL;
const ctrlRatio = (preS && postS) ? postS / preS : null;
const adjusted = ctrlRatio ? rawRatio / ctrlRatio : rawRatio;
// Share of plays that never met the old watch-time bar: if J plays now count for
// every 1 that used to, then (J-1)/J of them fell short.
const shortfall = adjusted > 1 ? (adjusted - 1) / adjusted : 0;

// The 95% interval on the factor, from resampling the real daily spread:
// +/-16% at 7 days each side, +/-11% at 14, +/-8% at 28. That is closely
// 0.42/sqrt(days), which is what this uses.
//
// The previous gate was `Math.abs(adjusted - 1) >= 0.10` - effect size alone,
// with no test of how much data produced it. At 7 days the noise floor is
// +/-16%, so a fixed 10% bar sat BELOW it: it would have certified noise as a
// finding and published a percentage on the live site.
const noise95 = 0.42 / Math.sqrt(USABLE);
const ctrlDrift = ctrlRatio == null ? null : Math.abs(ctrlRatio - 1);
const enoughData   = USABLE >= 14;                            // two whole weeks minimum
const clearsNoise  = Math.abs(adjusted - 1) > noise95;         // beats THIS window's floor
const controlQuiet = ctrlDrift != null && ctrlDrift <= 0.05;   // Shorts must NOT have moved
const confident = enoughData && clearsNoise && controlQuiet;

console.log('');
console.log(`  long-form step      ${((rawRatio - 1) * 100).toFixed(1)}%`);
if (ctrlRatio !== null) console.log(`  shorts drift        ${((ctrlRatio - 1) * 100).toFixed(1)}%  (removed from the figure below)`);
console.log(`  CALIBRATION FACTOR  ${adjusted.toFixed(3)}  +/-${(noise95 * 100).toFixed(0)}% at 95% on ${USABLE} days`);
console.log(`  => ${(shortfall * 100).toFixed(0)}% of plays never met the old watch-time bar`);
console.log('');

if (confident) {
  console.log('  PUBLISHABLE - the site will show this percentage in the notice.');
} else {
  console.log('  HELD BACK - the site shows the notice with NO percentage because:');
  if (!enoughData)   console.log(`     - only ${USABLE} day(s) each side; 14 is the minimum`);
  if (!clearsNoise)  console.log(`     - the ${(Math.abs(adjusted - 1) * 100).toFixed(1)}% effect is inside this window's +/-${(noise95 * 100).toFixed(0)}% noise floor`);
  if (!controlQuiet) console.log(`     - the Shorts control ${ctrlDrift == null ? 'is unavailable' : 'moved ' + (ctrlDrift * 100).toFixed(1) + '%, so drift is contaminating the comparison'}`);
}

cfg.status = confident ? 'measured' : 'provisional';
cfg.measured = {
  measuredOn: new Date().toISOString().slice(0, 10),
  daysEachSide: USABLE,
  wholeWeeks: WEEKS,
  longFormPrePerDay: Math.round(preL),
  longFormPostPerDay: Math.round(postL),
  shortsPrePerDay: preS == null ? null : Math.round(preS),
  shortsPostPerDay: postS == null ? null : Math.round(postS),
  rawRatio: +rawRatio.toFixed(4),
  controlRatio: ctrlRatio == null ? null : +ctrlRatio.toFixed(4),
  factor: +adjusted.toFixed(4),
  noise95: +noise95.toFixed(4),
  playsBelowOldBar: +shortfall.toFixed(4),
  // The site prints a percentage ONLY when this is true. All three conditions
  // must hold; any one failing keeps the notice qualitative.
  confident,
  heldBackBecause: confident ? null : { enoughData, clearsNoise, controlQuiet },
};
if (DRY) { console.log('\n--dry: nothing written.'); process.exit(0); }
fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');
console.log(`\nwrote ${path.relative(ROOT, CFG)}`);

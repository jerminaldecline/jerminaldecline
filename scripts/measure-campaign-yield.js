#!/usr/bin/env node
/**
 * measure-campaign-yield.js — how many views one day of advertising actually buys.
 *
 * The paid-promotion panel used to price "excess views over the month's median"
 * at industry CPV. That credits every view a promoted video earned above a
 * typical upload to advertising, which is wrong in both directions: a video that
 * would have done well anyway is booked as bought, and a promoted flop reads as
 * costing nothing. Measured against real campaigns it overstated by ~5.5x.
 *
 * We can do better now. The Transparency Centre gives exact campaign windows
 * (ad-campaigns.json) and the snapshot archive gives twice-daily view counts, so
 * for any campaign inside the snapshot era the views gained during it — net of
 * the video's own dormant baseline — is a direct measurement.
 *
 * Only videos AGE_MIN+ days old are used. Before that, launch traffic and paid
 * traffic are entangled: a young video's prior-days decay rate is far higher
 * than its organic rate during the campaign would be, so subtracting it wipes
 * out the real uplift and reports a spurious zero. This is the same 14-day line
 * ad-ledger.json already draws.
 *
 * Writes public/ad-yield.json: the measured per-campaign-day rate plus the
 * measurements behind it, so the page can price a video's own campaign-days
 * rather than a network-wide guess.
 *
 * Env:  SNAPSHOTS_DIR  (default: ../../jerminaldecline-snapshots/snapshots)
 * Args: --quiet
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SNAP_DIR = process.env.SNAPSHOTS_DIR
  || path.join(__dirname, '..', '..', 'jerminaldecline-snapshots', 'snapshots');
const CAMPAIGNS = path.join(ROOT, 'public', 'ad-campaigns.json');
const DATA = path.join(ROOT, 'public', 'data.json');
const OUT = path.join(ROOT, 'public', 'ad-yield.json');

const QUIET = process.argv.includes('--quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };

const AGE_MIN = 14;        // days after upload before paid can be separated
const MIN_SAMPLE = 3;      // below this the rate is not worth publishing

// What a view costs. This is the one borrowed number in the estimate — the
// yield rate above it is measured from our own archive, but nobody publishes
// what this advertiser actually pays, so CPV comes from published benchmarks.
//
// It previously ran $0.03–$0.10, which priced him like a personal-injury firm:
// $0.03 is roughly the whole market's average, and the $0.05–$0.10 band belongs
// to finance, legal and tech. Commentary sits at the cheap end. Reference points
// for 2026: a $0.024 cross-network average for skippable in-stream, by-device
// figures of $0.022 mobile / $0.029 desktop / $0.038 connected TV, and a
// by-industry spread from $0.018 (CPG) to $0.058 (legal).
//
// So: centred near that $0.024 average, with headroom at the top for US-only
// targeting and any CTV skew. Both ends still lean high rather than low, because
// the views we measure are public-counter increments and not every one of those
// is a billable view.
const CPV = { low: 0.015, high: 0.04 };
const CPV_BASIS = '2026 published benchmarks: ~$0.024 cross-network average for skippable '
  + 'in-stream; $0.022 mobile / $0.029 desktop / $0.038 CTV; $0.018 (CPG) to $0.058 (legal) '
  + 'by industry. Commentary sits at the cheap end, so the band is centred near the average '
  + 'rather than in the $0.05+ range used by finance, legal and tech.';

const day = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => day(Date.parse(d) + n * 864e5);
const span = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);

function main() {
  if (!fs.existsSync(CAMPAIGNS)) { console.error('no ad-campaigns.json; run scrape-ads.py --campaigns first'); process.exit(2); }
  if (!fs.existsSync(SNAP_DIR)) { console.error('snapshots dir not found: ' + SNAP_DIR); process.exit(2); }

  const camp = JSON.parse(fs.readFileSync(CAMPAIGNS, 'utf8'));
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const meta = Object.fromEntries((data.videos || []).map(v => [v.id, v]));

  const files = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith('.json.gz')).sort();
  if (files.length < 20) { console.error(`need >=20 snapshots, found ${files.length}`); process.exit(2); }
  const eraFrom = files[0].slice(0, 10), eraTo = camp._generated;

  // Campaign windows we can measure: inside the snapshot era, on an aged video.
  const all = [];
  for (const [id, v] of Object.entries(camp.videos))
    for (const w of (v.windows || [])) if (w && w[0] && w[1]) all.push({ id, from: w[0], to: w[1] });

  const candidates = all.filter(w => {
    if (!(w.from >= eraFrom && w.to <= eraTo)) return false;
    const p = meta[w.id];
    return p && p.publishedAt && span(p.publishedAt.slice(0, 10), w.from) >= AGE_MIN;
  });
  log(`${all.length} campaign windows on record; ${candidates.length} measurable ` +
      `(inside ${eraFrom}..${eraTo}, video ${AGE_MIN}+ days old)`);
  if (!candidates.length) { console.error('nothing measurable yet'); process.exit(3); }

  // Read view series for just the videos we need.
  const ids = new Set(candidates.map(w => w.id));
  const series = {};
  for (const id of ids) series[id] = {};
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP_DIR, f))).toString('utf8')); }
    catch { continue; }
    const d = f.slice(0, 10);
    for (const v of (doc.videos || [])) if (series[v.id]) series[v.id][d] = v.views;   // last read of a day wins
  }

  const at = (id, d) => {
    for (let i = 0; i <= 4; i++) { const k = addDays(d, -i); if (series[id][k] != null) return series[id][k]; }
    return null;
  };

  // Dormant baseline: median daily gain over the fortnight before the campaign,
  // skipping days inside any other campaign for the same video (plus a two-day
  // tail, since a campaign's traffic doesn't stop dead on its end date).
  const baseline = (id, from) => {
    const busy = new Set();
    for (const w of (camp.videos[id].windows || []))
      for (let d = w[0]; d <= addDays(w[1], 2); d = addDays(d, 1)) busy.add(d);
    const gains = [];
    for (let i = 14; i >= 2; i--) {
      const a = addDays(from, -i), b = addDays(from, -i + 1);
      if (busy.has(a) || busy.has(b)) continue;
      const va = at(id, a), vb = at(id, b);
      if (va != null && vb != null && vb >= va) gains.push(vb - va);
    }
    if (gains.length < 3) return null;
    gains.sort((x, y) => x - y);
    return gains[Math.floor(gains.length / 2)];
  };

  const measurements = [];
  for (const w of candidates) {
    // A campaign still running at the capture date is only partly observed.
    if (w.to === eraTo) continue;
    const len = span(w.from, w.to) + 1;
    const v0 = at(w.id, addDays(w.from, -1)), v1 = at(w.id, w.to), base = baseline(w.id, w.from);
    if (v0 == null || v1 == null || base == null) continue;
    const adViews = Math.max(0, (v1 - v0) - base * len);
    measurements.push({ id: w.id, title: (meta[w.id] || {}).title || '', from: w.from, to: w.to,
      days: len, gain: v1 - v0, baselinePerDay: base, adViews: Math.round(adViews),
      perDay: Math.round(adViews / len) });
  }

  if (measurements.length < MIN_SAMPLE) {
    console.error(`only ${measurements.length} usable measurements (need ${MIN_SAMPLE}); not writing`);
    process.exit(3);
  }

  const totDays = measurements.reduce((s, m) => s + m.days, 0);
  const totAd = measurements.reduce((s, m) => s + m.adViews, 0);
  const perDay = measurements.map(m => m.perDay).sort((a, b) => a - b);
  const rate = {
    low: perDay[0],
    central: Math.round(totAd / totDays),          // pooled, not a mean of means
    high: perDay[perDay.length - 1],
  };

  // Campaign-days per video, so the page can price whatever scope it is showing
  // rather than a single network-wide number.
  const campaignDays = {};
  for (const w of all) campaignDays[w.id] = (campaignDays[w.id] || 0) + span(w.from, w.to) + 1;

  const doc = {
    _note: 'Measured yield of paid promotion: how many views one campaign-day actually buys. ' +
      'Derived by comparing view counts across a known campaign window against the video\'s own ' +
      'dormant baseline, for campaigns inside the snapshot era on videos at least ' + AGE_MIN +
      ' days old (younger than that, launch traffic and paid traffic cannot be separated). ' +
      'Replaces pricing "excess views over the month\'s median", which credited organic ' +
      'outperformance to advertising and overstated the total several-fold.',
    _generated: new Date().toISOString().slice(0, 10),
    method: 'view gain across the campaign window minus the video\'s dormant baseline',
    snapshotEra: { from: eraFrom, to: eraTo, snapshots: files.length },
    ageMinDays: AGE_MIN,
    sample: { campaigns: measurements.length, campaignDays: totDays, adViews: totAd },
    viewsPerCampaignDay: rate,
    cpvUSD: CPV,
    cpvBasis: CPV_BASIS,
    campaignDaysByVideo: campaignDays,
    measurements: measurements.sort((a, b) => a.from.localeCompare(b.from)),
  };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');

  log(`\nmeasured ${measurements.length} completed campaigns over ${totDays} campaign-days`);
  log(`views per campaign-day: low ${rate.low}  central ${rate.central}  high ${rate.high}`);
  const totalDays = Object.values(campaignDays).reduce((s, n) => s + n, 0);
  log(`network-wide: ${totalDays} campaign-days -> ` +
      `${(rate.central * totalDays).toLocaleString()} ad-driven views -> ` +
      `$${Math.round(rate.central * totalDays * CPV.low).toLocaleString()}–` +
      `$${Math.round(rate.central * totalDays * CPV.high).toLocaleString()}`);
  log(`wrote ${path.relative(ROOT, OUT)}`);
}

if (require.main === module) main();

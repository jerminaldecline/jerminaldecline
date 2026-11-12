#!/usr/bin/env node
/**
 * Build public/month-to-date.json — the in-progress month's comparators,
 * taken at the SAME POINT of the previous month and of the same month a year
 * ago, so the Overview's "vs Oct" / "vs Nov '25" deltas compare like with like
 * while a month is still running.
 *
 * Why: the Overview's month objects are whole-month totals. Twelve days into
 * November the cards were comparing twelve days of uploads (still young) against
 * all of October's uploads at their lifetime views, and reporting the month a
 * third down when it was running well ahead. A banner saying "may not be
 * meaningful" does not fix a figure with the wrong sign.
 *
 * How: the live data.json is a point-in-time reading at meta.lastUpdated. The
 * sibling jerminaldecline-snapshots repo holds twice-daily dumps of the same
 * file, so "October as it stood at this point" is simply the dump captured one
 * calendar month before that moment — same day of the month, same time of day,
 * to within a few hours. Every figure the cards show a delta for is recomputed
 * from that dump with the page's own formulas (computeStats in index.html), over
 * the videos it holds for that month, so the comparator carries the same age
 * structure as the live figure it is set against.
 *
 * A year back there is no dump (the archive starts June 2026), so the year-ago
 * side carries only what publish dates and durations give exactly — upload
 * counts, runtime, average length — and leaves the view-based figures null; the
 * page shows no delta for those rather than a wrong one.
 *
 * Videos the live data marks unavailable are excluded on every side, matching
 * the rest of the site.
 *
 * Usage:  node scripts/build-month-to-date.js
 *         node scripts/build-month-to-date.js --snapshots ../jerminaldecline-snapshots/snapshots
 *         node scripts/build-month-to-date.js --at 2026-11-12T09:14:00Z   (pretend "now")
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const argv = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const SNAP_DIR = path.resolve(argv('--snapshots') || process.env.SNAPSHOTS_DIR || path.join(__dirname, '..', '..', 'jerminaldecline-snapshots', 'snapshots'));
const DATA = path.join(__dirname, '..', 'public', 'data.json');
const OUT = path.join(__dirname, '..', 'public', 'month-to-date.json');

// ---- the page's formulas, copied so the comparator is computed the same way ----
// These must match index.html (VCC_FACTOR, VCC_MID, VCC_FROM, VCC_CURVE, RPM,
// rpmFor, vccExposure, vccEngagedOne, computeStats). If one moves, move both.
const VCC_FACTOR = { low: 1.94, high: 2.24 };
const VCC_MID = 2.07;
const VCC_FROM = Date.parse('2026-08-27T00:00:00Z');
const VCC_CURVE = [[0, 0], [0.5, 0.416], [1, 0.718], [2, 0.917], [3, 0.96], [7, 0.995], [14, 0.999], [21, 1]];
const RPM = { l8: [0.85, 1.28], l38: [0.50, 1.00], sub3: [0.30, 0.60], shorts: [0.02, 0.07] };
function rpmFor(d) { if (d >= 480) return RPM.l8; if (d >= 180) return RPM.l38; return RPM.sub3; }
function vccExposure(publishedAt) {
  const days = (VCC_FROM - Date.parse(publishedAt)) / 86400000;
  if (!(days > 0)) return 1;
  if (days >= 21) return 0;
  let acc = 1;
  for (let i = 1; i < VCC_CURVE.length; i++) {
    const [d0, a0] = VCC_CURVE[i - 1], [d1, a1] = VCC_CURVE[i];
    if (days <= d1) { acc = a0 + (a1 - a0) * ((days - d0) / (d1 - d0)); break; }
  }
  return 1 - acc;
}
function vccEngagedOne(v, J) {
  const n = v.views || 0;
  if (!(J > 1)) return n;
  return n / (1 + (J - 1) * vccExposure(v.publishedAt));
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// The subset of computeStats the Overview reads a delta from.
function stats(vs, sh) {
  const shorts = { n: sh.length, v: sh.reduce((s, x) => s + (x.views || 0), 0), med: sh.length ? median(sh.map(x => x.views || 0)) : 0 };
  const srevlo = Math.round(sh.reduce((s, v) => s + ((v.views || 0) / 1000) * RPM.shorts[0], 0));
  const srevhi = Math.round(sh.reduce((s, v) => s + ((v.views || 0) / 1000) * RPM.shorts[1], 0));
  if (!vs.length) {
    return { n: 0, tot: 0, comments: 0, runtime: 0, med: null, lv: null, avglen: null, engaged: 0, engagedMed: null,
             lrevlo: 0, lrevhi: 0, srevlo, srevhi, shorts };
  }
  const views = vs.map(v => v.views || 0);
  const lvs = vs.filter(v => v.views > 0 && v.likes != null).map(v => v.likes / v.views);
  const durs = vs.filter(v => v.durationSec).map(v => v.durationSec);
  return {
    n: vs.length,
    tot: views.reduce((a, b) => a + b, 0),
    med: Math.round(median(views)),
    engaged: Math.round(vs.reduce((s, v) => s + vccEngagedOne(v, VCC_MID), 0)),
    engagedMed: Math.round(median(vs.map(v => vccEngagedOne(v, VCC_MID)))),
    lv: lvs.length ? Math.round(median(lvs) * 1000) / 10 : 0,
    comments: vs.reduce((s, v) => s + (v.comments || 0), 0),
    avglen: durs.length ? Math.round(median(durs) / 60 * 10) / 10 : 0,
    runtime: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / 3600 * 10) / 10 : 0,
    lrevlo: Math.round(vs.reduce((s, v) => s + (vccEngagedOne(v, VCC_FACTOR.high) / 1000) * rpmFor(v.durationSec || 600)[0], 0)),
    lrevhi: Math.round(vs.reduce((s, v) => s + (vccEngagedOne(v, VCC_FACTOR.low) / 1000) * rpmFor(v.durationSec || 600)[1], 0)),
    srevlo, srevhi, shorts,
  };
}
// The year-ago side has no dump, so only the publish-date and duration figures
// are exact. Everything view-based stays null and the page shows no delta.
function statsNoViews(vs, sh) {
  const durs = vs.filter(v => v.durationSec).map(v => v.durationSec);
  return { n: vs.length, tot: null, med: null, engaged: null, engagedMed: null, lv: null, comments: null,
           avglen: durs.length ? Math.round(median(durs) / 60 * 10) / 10 : 0,
           runtime: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / 3600 * 10) / 10 : 0,
           lrevlo: null, lrevhi: null, srevlo: null, srevhi: null,
           shorts: { n: sh.length, v: null, med: null } };
}

// ---- Central-time helpers (the page keys months by the creator's local month) ----
const _fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function ctParts(ms) {
  const o = {};
  for (const x of _fmt.formatToParts(new Date(ms))) if (x.type !== 'literal') o[x.type] = x.value;
  return { ym: o.year + '-' + o.month, dom: +o.day, hour: +o.hour % 24, minute: +o.minute };
}
const _pmCache = new Map();
function ctMonth(iso) {
  if (!iso) return null;
  if (_pmCache.has(iso)) return _pmCache.get(iso);
  let ym;
  try { ym = ctParts(Date.parse(iso)).ym; } catch (e) { ym = String(iso).slice(0, 7); }
  _pmCache.set(iso, ym);
  return ym;
}
const monthShift = (ym, delta) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + delta, 1)); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
const daysInMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
// The same point in another month: same day of the month (clamped) and the same
// clock time, found by stepping the instant back a month at a time in UTC. The
// few hours a DST change can add are well inside the half-day the dump cadence
// already allows.
function samePoint(ms, monthsBack) {
  const d = new Date(ms);
  const ym = monthShift(ctParts(ms).ym, -monthsBack);
  const dom = Math.min(ctParts(ms).dom, daysInMonth(ym));
  const [y, m] = ym.split('-').map(Number);
  // Keep the UTC clock time; land on the clamped day in the target month.
  return Date.UTC(y, m - 1, dom, d.getUTCHours(), d.getUTCMinutes(), 0);
}

function loadDump(file) {
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SNAP_DIR, file))));
  return { videos: j.videos || [], at: (j.meta && Date.parse(j.meta.lastUpdated)) || null };
}
// Closest dump to a target instant, searched over the three dates around it.
function nearestDump(targetMs) {
  const day = 86400000;
  const names = [];
  for (const off of [-day, 0, day]) {
    const iso = new Date(targetMs + off).toISOString().slice(0, 10);
    for (const half of ['AM', 'PM']) names.push(`${iso}-${half}.json.gz`);
  }
  let best = null;
  for (const f of names) {
    if (!fs.existsSync(path.join(SNAP_DIR, f))) continue;
    const dump = loadDump(f);
    const at = dump.at || Date.parse(f.slice(0, 10) + (f.includes('-AM') ? 'T02:00:00Z' : 'T14:00:00Z'));
    const gap = Math.abs(at - targetMs);
    if (!best || gap < best.gap) best = { file: f, dump, at, gap };
  }
  return best;
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const liveAt = Date.parse(argv('--at') || (data.meta && data.meta.lastUpdated) || new Date().toISOString());
  const now = ctParts(liveAt);
  const unavailable = new Set((data.videos || []).filter(v => v.unavailable).map(v => v.id));
  const channels = data.channels || {};
  const scopes = { ALL: () => true };
  for (const [cid, c] of Object.entries(channels)) if (c.handle) scopes[c.handle] = (v) => v.channelId === cid;

  const prevYm = monthShift(now.ym, -1), yoyYm = monthShift(now.ym, -12);
  const prevTarget = samePoint(liveAt, 1), yoyTarget = samePoint(liveAt, 12);
  const prevDump = nearestDump(prevTarget);
  const yoyDump = nearestDump(yoyTarget);   // null until the archive is a year deep
  console.log(`live data at ${new Date(liveAt).toISOString()} = ${now.ym} day ${now.dom}, ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')} CT`);
  console.log(`previous month ${prevYm}: target ${new Date(prevTarget).toISOString()} -> ${prevDump ? prevDump.file + ' (' + (prevDump.gap / 3600000).toFixed(1) + 'h off)' : 'NO DUMP'}`);
  console.log(`year ago ${yoyYm}: target ${new Date(yoyTarget).toISOString()} -> ${yoyDump ? yoyDump.file : 'no dump (publish-date figures only)'}`);

  const pick = (videos, ym, cutoffMs, test) => videos.filter(v => !unavailable.has(v.id) && ctMonth(v.publishedAt) === ym
    && (cutoffMs == null || Date.parse(v.publishedAt) <= cutoffMs) && test(v));
  const out = {
    _note: 'Comparators for the in-progress month, taken at the same point of the previous month and of the same month a year ago, '
         + 'so the Overview can compare like with like while a month is still running. prev is recomputed from the snapshot dump '
         + 'nearest to one calendar month before the live reading, with the page\'s own formulas; yoy has no dump and carries only '
         + 'the publish-date and duration figures. Built by scripts/build-month-to-date.js.',
    generated: new Date().toISOString(),
    month: now.ym,
    dom: now.dom,
    liveAt: new Date(liveAt).toISOString(),
    prev: { month: prevYm, asOf: prevDump ? new Date(prevDump.at).toISOString() : null, dump: prevDump ? prevDump.file : null, offsetHours: prevDump ? Math.round(prevDump.gap / 360000) / 10 : null },
    yoy: { month: yoyYm, asOf: yoyDump ? new Date(yoyDump.at).toISOString() : null, dump: yoyDump ? yoyDump.file : null },
    scopes: {},
  };
  for (const [key, test] of Object.entries(scopes)) {
    const entry = {};
    if (prevDump) {
      const vids = prevDump.dump.videos;
      entry.prev = stats(pick(vids, prevYm, null, v => !v.isShort && test(v)), pick(vids, prevYm, null, v => v.isShort && test(v)));
    } else entry.prev = null;
    if (yoyDump) {
      const vids = yoyDump.dump.videos;
      entry.yoy = stats(pick(vids, yoyYm, null, v => !v.isShort && test(v)), pick(vids, yoyYm, null, v => v.isShort && test(v)));
    } else {
      // No dump a year back: count what had been published by that point from the live file.
      entry.yoy = statsNoViews(pick(data.videos, yoyYm, yoyTarget, v => !v.isShort && test(v)), pick(data.videos, yoyYm, yoyTarget, v => v.isShort && test(v)));
    }
    out.scopes[key] = entry;
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  const a = out.scopes.ALL;
  console.log(`wrote ${path.relative(process.cwd(), OUT)}: ${Object.keys(out.scopes).length} scopes; ALL prev n=${a.prev ? a.prev.n : '-'} tot=${a.prev ? a.prev.tot : '-'} | yoy n=${a.yoy.n}`);
}

main();

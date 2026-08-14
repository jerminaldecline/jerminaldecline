#!/usr/bin/env node
/**
 * Detect videos whose thumbnail was changed AFTER upload, and write
 * public/thumb-history.json.
 *
 * We never stored thumbnails, and we don't need to. Every thumbnail URL is
 * derived (`i.ytimg.com/vi/<id>/mqdefault.jpg`) and is byte-identical before and
 * after a swap, so the URL tells you nothing. But the ETag ytimg returns is not
 * an opaque hash — it is the UNIX TIMESTAMP OF THE CUSTOM-THUMBNAIL UPLOAD. That
 * makes the whole history readable from a HEAD request, retroactively, with no
 * stored images, no hashing and no API quota.
 *
 *   etag="1779911610"  -> custom thumbnail, set at that unix time
 *   etag="0"           -> no custom thumbnail (auto-generated frame)
 *   404                -> video gone (thumbnail is pulled with it)
 *
 * LONG-FORM ONLY. Shorts never carry a custom thumbnail, so they all report
 * etag="0" and a Shorts thumbnail swap is NOT detectable this way — it would
 * need stored image hashes going forward and could not see the past at all.
 *
 * A thumbnail set slightly after upload is normal (scheduling, a quick fix), so
 * only a delay beyond THRESHOLD_DAYS counts as a change.
 *
 * Usage:
 *   node scripts/thumb-history.js              # full long-form backfill
 *   node scripts/thumb-history.js --limit 200  # sample run
 *   node scripts/thumb-history.js --since 2026-01-01
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'public', 'data.json');
const OUT = path.join(__dirname, '..', 'public', 'thumb-history.json');
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const LIMIT = Number(argVal('--limit', 0)) || 0;
const SINCE = argVal('--since', '');
// Below this a late thumbnail is just the upload settling (scheduled publish,
// an immediate correction), not a deliberate re-thumbnail.
const THRESHOLD_DAYS = 2;
const CONCURRENCY = 8;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function headThumb(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, { method: 'HEAD' });
      if (res.status === 404) return { gone: true };
      if (!res.ok) { await sleep(400 * (attempt + 1)); continue; }
      const raw = (res.headers.get('etag') || '').replace(/"/g, '');
      const n = Number(raw);
      // etag "0" is the documented no-custom-thumbnail case, not a parse failure.
      if (!Number.isFinite(n)) return { unknown: raw };
      if (n < 1e9) return { auto: true };
      return { ts: n * 1000 };
    } catch (e) {
      await sleep(400 * (attempt + 1));
    }
  }
  return { failed: true };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  let vids = (data.videos || []).filter(v => v && !v.unavailable && !v.isShort);
  if (SINCE) vids = vids.filter(v => (v.publishedAt || '') >= SINCE);
  vids.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  if (LIMIT) vids = vids.slice(0, LIMIT);

  console.log(`Checking ${vids.length.toLocaleString()} long-form videos (concurrency ${CONCURRENCY})…`);

  const changed = {};
  const tally = { checked: 0, custom: 0, auto: 0, gone: 0, failed: 0, changed: 0 };
  let cursor = 0;

  async function worker() {
    while (cursor < vids.length) {
      const v = vids[cursor++];
      const r = await headThumb(v.id);
      tally.checked++;
      if (tally.checked % 500 === 0) {
        console.log(`  …${tally.checked.toLocaleString()} / ${vids.length.toLocaleString()} (${tally.changed} changed)`);
      }
      if (r.gone) { tally.gone++; continue; }
      if (r.failed) { tally.failed++; continue; }
      if (r.auto || r.unknown !== undefined) { tally.auto++; continue; }
      tally.custom++;
      const pub = Date.parse(v.publishedAt);
      if (!Number.isFinite(pub)) continue;
      const delayDays = Math.round((r.ts - pub) / 86400000);
      if (delayDays > THRESHOLD_DAYS) {
        tally.changed++;
        changed[v.id] = { thumbSet: new Date(r.ts).toISOString(), delayDays };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Most detections are NOT per-video repackaging. Re-thumbnailing dozens of
  // videos on one day is a channel-wide rebrand (or a platform-side migration):
  // 98 videos on 2018-01-03 and ~164 across a week of Feb 2013 accounted for
  // 272 of the first 345 hits. Reporting those as individual decisions would
  // badly overstate the behaviour, so each entry is labelled with the sweep it
  // belongs to and the page can separate the two.
  const SWEEP_MIN = 5;
  const perDay = {};
  for (const id of Object.keys(changed)) {
    const day = changed[id].thumbSet.slice(0, 10);
    (perDay[day] = perDay[day] || []).push(id);
  }
  const sweeps = {};
  for (const [day, ids] of Object.entries(perDay)) {
    if (ids.length < SWEEP_MIN) continue;
    sweeps[day] = ids.length;
    for (const id of ids) changed[id].sweep = day;
  }
  const isolated = Object.values(changed).filter(o => !o.sweep).length;

  // Titles/channels are deliberately NOT copied in — the page already has them in
  // data.json and duplicating them here would go stale on every retitle.
  const store = {
    _note: 'Long-form videos whose custom thumbnail was uploaded more than ' +
      THRESHOLD_DAYS + ' days after the video went live — i.e. the thumbnail was ' +
      'changed after publication. Shorts are excluded: they carry no custom ' +
      'thumbnail, so this method cannot see changes to them.',
    _method: 'i.ytimg.com mqdefault ETag = unix timestamp of the custom-thumbnail upload (HEAD request, no API quota)',
    _generated: new Date().toISOString().slice(0, 10),
    _thresholdDays: THRESHOLD_DAYS,
    _sweepMin: SWEEP_MIN,
    _longformChecked: tally.checked,
    _withCustomThumb: tally.custom,
    _changed: tally.changed,
    _isolated: isolated,
    sweeps,
    videos: changed,
  };
  fs.writeFileSync(OUT, JSON.stringify(store, null, 1));

  console.log('\n' + JSON.stringify(tally));
  console.log(`thumb-history.json: ${tally.changed} changed of ${tally.custom} with a custom thumbnail`);
  console.log(`  ${isolated} isolated (per-video) · ${tally.changed - isolated} in ${Object.keys(sweeps).length} bulk sweeps`);
  for (const [day, n] of Object.entries(sweeps).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log(`    sweep ${day}: ${n} videos`);
  }
  const byId = new Map((data.videos || []).map(v => [v.id, v]));
  const recent = Object.entries(changed).filter(([, o]) => !o.sweep)
    .sort((a, b) => String(b[1].thumbSet).localeCompare(String(a[1].thumbSet))).slice(0, 8);
  console.log('  most recent isolated:');
  for (const [id, o] of recent) {
    const v = byId.get(id) || {};
    console.log(`    ${o.thumbSet.slice(0, 10)}  +${String(o.delayDays).padStart(4)}d  ${String(v.title || '').slice(0, 44)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Resolve WHY each removed video is unavailable and write public/removed-reasons.json.
 *
 * The audit (fetch-data.js) only knows a video is gone — the YouTube Data API
 * returns nothing for deleted/private videos, with no reason. To distinguish
 * private vs. copyright-takedown vs. Terms-of-Service vs. plain deletion we
 * have to read the watch page's `playabilityStatus`. This runs that check only
 * for the small unavailable set, incrementally: entries already resolved (and
 * not stale) are left untouched, so a normal run makes just a handful of
 * requests. The Removed tab reads this side-file to label + sort by reason.
 *
 * Kept OUT of the hourly fetch-data.js on purpose: watch-page scraping is
 * rate-limited and often bot-walled from datacenter IPs (GitHub Actions), so it
 * runs best-effort and never blocks the data build. Run it locally, or wire it
 * as a non-fatal step. Existing reasons persist when a run can't reach YouTube.
 *
 * Usage:
 *   node scripts/resolve-removed-reasons.js            # incremental
 *   node scripts/resolve-removed-reasons.js --refresh 7  # also re-check entries older than 7 days
 *   node scripts/resolve-removed-reasons.js --all        # re-check everything
 */
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'public', 'data.json');
const OUT = path.join(__dirname, '..', 'public', 'removed-reasons.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36';
const args = process.argv.slice(2);
const REFRESH_DAYS = args.includes('--all') ? 0 : (args.includes('--refresh') ? Number(args[args.indexOf('--refresh') + 1]) || 7 : Infinity);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function classify(status, reason, sub) {
  const t = ((reason || '') + ' ' + (sub || '')).toLowerCase();
  if (status === 'OK') return { reason: 'public' };                 // reinstated — caller prunes
  if (status === 'LOGIN_REQUIRED') return { reason: 'private' };
  if (t.includes('copyright')) {
    const m = /request by (.+?)[.\s]*$/i.exec(sub || '');
    return { reason: 'copyright', detail: m ? m[1].trim() : undefined };
  }
  if (t.includes('terms of service')) return { reason: 'terms' };
  if (t.includes('community guidelines')) return { reason: 'guidelines' };
  if (t.includes('account associated with this video has been terminated')) return { reason: 'terminated' };
  if (t.includes('removed by the uploader')) return { reason: 'deleted' };
  if (t.includes("isn't available anymore") || t.includes('no longer available')) return { reason: 'deleted' };
  if (t.includes('private')) return { reason: 'private' };
  if (status === 'ERROR' || status === 'UNPLAYABLE') return { reason: 'unavailable' };
  return null; // couldn't parse (consent wall / network) — keep existing
}

async function resolveOne(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let html;
    try {
      const res = await fetch('https://www.youtube.com/watch?v=' + id, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      });
      if (res.status === 429) { await sleep(20000); continue; }
      html = await res.text();
    } catch (e) {
      await sleep(3000); continue;
    }
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script>|if)/s);
    if (!m) return null;
    let ps;
    try { ps = JSON.parse(m[1]).playabilityStatus || {}; } catch { return null; }
    const er = (ps.errorScreen && ps.errorScreen.playerErrorMessageRenderer) || {};
    const st = er.subreason || {};
    const sub = st.runs ? st.runs.map(r => r.text || '').join('') : (st.simpleText || '');
    return classify(ps.status || '', ps.reason || '', sub);
  }
  return null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  let store = { _note: 'Resolved unavailability reason per removed video, from YouTube watch-page playabilityStatus.', _method: 'watch-page playabilityStatus scrape', _generated: '', reasons: {} };
  try { store = { ...store, ...JSON.parse(fs.readFileSync(OUT, 'utf8')) }; store.reasons = store.reasons || {}; } catch {}

  const removed = data.videos.filter(v => v.unavailable || v.unlisted);
  const removedIds = new Set(removed.map(v => v.id));
  // Prune reasons for videos no longer removed (reinstated / back to public).
  for (const id of Object.keys(store.reasons)) if (!removedIds.has(id)) delete store.reasons[id];

  const now = Date.now();
  const stale = e => {
    if (REFRESH_DAYS === Infinity) return false;   // plain incremental run: never re-scrape a known reason
    if (REFRESH_DAYS === 0) return true;           // --all: re-check everything
    return !e || !e.checked || (now - Date.parse(e.checked)) / 86400000 >= REFRESH_DAYS;
  };

  let scraped = 0, changed = 0;
  for (const v of removed) {
    // Unlisted videos are still watchable — the state itself is the reason, no scrape needed.
    if (v.unlisted && !v.unavailable) {
      const prev = store.reasons[v.id];
      if (!prev || prev.reason !== 'unlisted') { store.reasons[v.id] = { reason: 'unlisted', checked: new Date().toISOString() }; changed++; }
      continue;
    }
    const prev = store.reasons[v.id];
    if (prev && prev.reason && prev.reason !== 'unavailable' && !stale(prev)) continue; // already known & fresh
    const r = await resolveOne(v.id);
    scraped++;
    await sleep(1400);
    if (!r) continue;                       // unreachable — keep any existing entry
    if (r.reason === 'public') { delete store.reasons[v.id]; changed++; continue; } // reinstated mid-run
    const next = { reason: r.reason, checked: new Date().toISOString() };
    if (r.detail) next.detail = r.detail;
    const before = prev ? prev.reason + '|' + (prev.detail || '') : '';
    if (before !== r.reason + '|' + (r.detail || '')) changed++;
    store.reasons[v.id] = next;
    if (scraped % 20 === 0) console.log('  …scraped ' + scraped);
  }

  store._generated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(OUT, JSON.stringify(store, null, 1));
  const tally = {};
  Object.values(store.reasons).forEach(o => { tally[o.reason] = (tally[o.reason] || 0) + 1; });
  console.log('removed-reasons.json: ' + Object.keys(store.reasons).length + ' entries (scraped ' + scraped + ', changed ' + changed + ')');
  console.log('tally: ' + JSON.stringify(tally));
}

main().catch(e => { console.error(e); process.exit(1); });

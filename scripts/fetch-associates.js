#!/usr/bin/env node
/**
 * Associates: channels connected to the network, tracked at overview depth.
 *
 * Maintains public/associates.json - channel stats plus per-video views,
 * likes, comments and length - for the handles in ASSOCIATES below. Nothing
 * else in the pipeline touches these channels: no transcripts, topic tagging,
 * snapshots, ad detection or repost scanning. Adding a channel is one line.
 *
 * Runs alongside fetch-data.js in the same workflows, with the same key:
 *   node scripts/fetch-associates.js            # incremental: last 60 days per channel
 *   node scripts/fetch-associates.js --audit    # also refresh every older video
 *
 * Cost per channel per incremental run is a handful of units (1 channels.list,
 * 1-2 playlistItems pages, 1-2 videos.list batches). The audit costs one
 * videos.list batch per 50 catalogue videos.
 *
 * Output shape mirrors data.json's, so the site can reuse its month
 * summaries and cards for these channels:
 *   channels: { <id>: { handle, title, url, subscriberCount, videoCount,
 *                       channelViews, snapshots: [{date, subscriberCount, channelViews, videoCount}] } }
 *   videos:   [ { id, channelId, title, publishedAt, durationSec, views, likes, comments, isShort, unavailable? } ]
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ASSOCIATES = [
  '@paramounttactical',
];

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) { console.error('YOUTUBE_API_KEY is not set'); process.exit(1); }
const OUT = path.join(__dirname, '..', 'public', 'associates.json');
const AUDIT = process.argv.includes('--audit');
const RECENT_WINDOW_DAYS = 60;
// Same Short heuristic as fetch-data.js: the API has no Shorts flag, so a
// sub-3-minute upload after the format existed counts as one.
const SHORTS_CUTOFF_SEC = 180;
const SHORTS_FORMAT_EARLIEST = '2021-03-18';
const isLikelyShort = (dur, pub) => !!dur && dur > 0 && dur <= SHORTS_CUTOFF_SEC && (pub || '') >= SHORTS_FORMAT_EARLIEST;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode !== 200) reject(new Error(`HTTP ${res.statusCode}: ${parsed.error?.message || body.slice(0, 200)}`));
          else resolve(parsed);
        } catch (e) { reject(new Error(`bad response: ${body.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}
function parseDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

async function resolveChannel(handle) {
  const d = await get(`https://www.googleapis.com/youtube/v3/channels?part=id,snippet,contentDetails,statistics&forHandle=${encodeURIComponent(handle)}&key=${API_KEY}`);
  const it = d.items && d.items[0];
  if (!it) throw new Error(`channel ${handle} not found`);
  return {
    id: it.id, handle, title: it.snippet.title, url: `https://www.youtube.com/${handle}`,
    uploadsPlaylistId: it.contentDetails.relatedPlaylists.uploads,
    subscriberCount: parseInt(it.statistics.subscriberCount || '0', 10),
    channelViews: parseInt(it.statistics.viewCount || '0', 10),
    videoCount: parseInt(it.statistics.videoCount || '0', 10),
  };
}

// Walk the uploads playlist newest-first; stop once past sinceDate (null = all).
async function listUploads(playlistId, sinceDate, channelId) {
  const out = []; let pageToken = '';
  for (;;) {
    const d = await get(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=50${pageToken ? '&pageToken=' + pageToken : ''}&key=${API_KEY}`);
    let past = false;
    for (const it of d.items || []) {
      const pub = it.contentDetails.videoPublishedAt || it.snippet.publishedAt;
      if (sinceDate && pub < sinceDate) { past = true; continue; }
      out.push({ id: it.contentDetails.videoId, channelId, title: it.snippet.title, publishedAt: pub });
    }
    pageToken = d.nextPageToken;
    if (!pageToken || past) break;
  }
  return out;
}

// videos.list in batches of 50. Returns a Map id -> details; ids absent from
// the response are gone (deleted/private) and the caller marks them.
async function enrich(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    // liveStreamingDetails is present on anything that went out live - stream
    // recordings and premieres. Paramount Tactical has ~450 stream VODs of two
    // hours and up against ~250 uploads, so they must be their own format or
    // every long-form median and runtime is meaningless.
    const d = await get(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,status,liveStreamingDetails&id=${batch.join(',')}&key=${API_KEY}`);
    for (const it of d.items || []) {
      if (it.status && it.status.privacyStatus === 'private') continue;   // reads as gone
      found.set(it.id, {
        durationSec: parseDuration(it.contentDetails.duration),
        views: parseInt(it.statistics.viewCount || '0', 10),
        likes: it.statistics.likeCount != null ? parseInt(it.statistics.likeCount, 10) : null,
        comments: it.statistics.commentCount != null ? parseInt(it.statistics.commentCount, 10) : null,
        isLive: !!(it.liveStreamingDetails && it.liveStreamingDetails.actualStartTime),
      });
    }
  }
  return found;
}

async function main() {
  let store = { _generated: null, _note: 'Associated channels tracked at overview depth: channel stats plus per-video views, likes, comments and length. No topics, transcripts or snapshots.', channels: {}, videos: [] };
  try { const prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); store = { ...store, ...prev, channels: prev.channels || {}, videos: prev.videos || [] }; } catch {}
  const byId = new Map(store.videos.map(v => [v.id, v]));
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - RECENT_WINDOW_DAYS * 864e5).toISOString();

  for (const handle of ASSOCIATES) {
    const ch = await resolveChannel(handle);
    const prevCh = store.channels[ch.id] || {};
    const firstRun = !store.videos.some(v => v.channelId === ch.id);
    console.log(`${handle}: ${ch.title} - ${ch.subscriberCount} subs, ${ch.videoCount} videos${firstRun ? ' (first run: full history)' : ''}`);

    // 1. recent uploads (or everything on the first run / audit)
    const listed = await listUploads(ch.uploadsPlaylistId, (firstRun || AUDIT) ? null : since, ch.id);
    for (const v of listed) {
      const cur = byId.get(v.id);
      if (cur) { cur.title = v.title; cur.publishedAt = v.publishedAt; }
      else { byId.set(v.id, { ...v, durationSec: 0, views: 0, likes: null, comments: null, isShort: false }); }
    }
    // 2. refresh stats: in-window videos every run, the whole catalogue on --audit
    const mine = [...byId.values()].filter(v => v.channelId === ch.id);
    const targets = mine.filter(v => AUDIT || firstRun || v.publishedAt >= since || !v.durationSec);
    const details = await enrich(targets.map(v => v.id));
    let gone = 0;
    for (const v of targets) {
      const d = details.get(v.id);
      if (!d) { if (!v.unavailable) { v.unavailable = true; v.unavailableSince = new Date().toISOString(); gone++; } continue; }
      if (v.unavailable) { delete v.unavailable; delete v.unavailableSince; }
      Object.assign(v, d);
      v.isShort = !v.isLive && isLikelyShort(v.durationSec, v.publishedAt);
    }
    console.log(`  listed ${listed.length}, refreshed ${targets.length}, newly unavailable ${gone}`);

    // 3. channel record + daily snapshot (one per day, replaced if re-run)
    const snaps = (prevCh.snapshots || []).filter(s => s.date !== today);
    snaps.push({ date: today, subscriberCount: ch.subscriberCount, channelViews: ch.channelViews, videoCount: ch.videoCount });
    store.channels[ch.id] = { handle: ch.handle, title: ch.title, url: ch.url, subscriberCount: ch.subscriberCount,
      videoCount: ch.videoCount, channelViews: ch.channelViews, snapshots: snaps.slice(-400) };
  }

  store.videos = [...byId.values()].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
  store._generated = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(store));
  console.log(`associates.json: ${Object.keys(store.channels).length} channel(s), ${store.videos.length} videos`);
}

main().catch(e => { console.error(e.message); process.exit(1); });

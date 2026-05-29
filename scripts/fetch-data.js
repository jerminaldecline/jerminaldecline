#!/usr/bin/env node
/**
 * Nightly fetcher for TheQuartering channel data.
 *
 * Strategy:
 * - On first run (no existing data file), fetches everything from 2 years ago
 *   to today so YoY comparison works from day one.
 * - On subsequent runs, only fetches the last 60 days of uploads to catch
 *   new videos and update view counts on recent content.
 * - Merges new data into the existing dataset and writes public/data.json.
 *
 * Required env vars:
 *   YOUTUBE_API_KEY — YouTube Data API v3 key
 *
 * Run:
 *   node scripts/fetch-data.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CHANNEL_HANDLE = '@TheQuartering';
const SHORTS_CUTOFF_SEC = 180; // 3 minutes
const RECENT_WINDOW_DAYS = 60; // how far back to refresh on incremental runs
const HISTORY_YEARS = 2; // how far back to fetch on first run
const DATA_FILE = path.join(__dirname, '..', 'public', 'data.json');

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error('Missing YOUTUBE_API_KEY environment variable.');
  process.exit(1);
}

// --- Helpers ---

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${parsed.error?.message || body}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Failed to parse response: ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function parseDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0)) * 3600 + (parseInt(m[2] || 0)) * 60 + (parseInt(m[3] || 0));
}

async function resolveChannel() {
  console.log(`Resolving channel ${CHANNEL_HANDLE}...`);
  const url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet,contentDetails&forHandle=${encodeURIComponent(CHANNEL_HANDLE)}&key=${API_KEY}`;
  const data = await get(url);
  if (!data.items || !data.items.length) throw new Error(`Channel ${CHANNEL_HANDLE} not found`);
  return {
    id: data.items[0].id,
    title: data.items[0].snippet.title,
    uploadsPlaylistId: data.items[0].contentDetails.relatedPlaylists.uploads
  };
}

async function listVideosFromPlaylist(playlistId, sinceDate) {
  const videos = [];
  let pageToken = '';
  let pages = 0;

  while (true) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${playlistId}&maxResults=50${pageToken ? '&pageToken=' + pageToken : ''}&key=${API_KEY}`;
    const data = await get(url);
    pages++;

    let allOlder = true;
    for (const item of data.items) {
      const publishedAt = new Date(item.contentDetails.videoPublishedAt || item.snippet.publishedAt);
      if (publishedAt > sinceDate) allOlder = false;
      if (publishedAt >= sinceDate) {
        videos.push({
          id: item.contentDetails.videoId,
          title: item.snippet.title,
          publishedAt: publishedAt.toISOString()
        });
      }
    }

    console.log(`  Page ${pages}: ${data.items.length} items, ${videos.length} in range so far`);

    if (allOlder && data.items.length > 0) break;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return videos;
}

async function enrichVideos(videos) {
  console.log(`Fetching duration + view stats for ${videos.length} videos...`);
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const ids = batch.map(v => v.id).join(',');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids}&key=${API_KEY}`;
    const data = await get(url);
    const byId = new Map(data.items.map(it => [it.id, it]));
    for (const v of batch) {
      const det = byId.get(v.id);
      if (det) {
        v.durationSec = parseDuration(det.contentDetails.duration);
        v.views = parseInt(det.statistics.viewCount || '0', 10);
        v.isShort = v.durationSec > 0 && v.durationSec <= SHORTS_CUTOFF_SEC;
      } else {
        // Video may have been deleted or made private — keep stub
        v.durationSec = 0;
        v.views = 0;
        v.isShort = false;
        v.unavailable = true;
      }
    }
    console.log(`  Enriched ${Math.min(i + 50, videos.length)} / ${videos.length}`);
  }
  return videos;
}

function loadExistingData() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    // Treat empty/placeholder datasets as no data so we trigger first-run mode
    if (!parsed.videos || parsed.videos.length === 0) {
      console.log('Existing data file is empty (placeholder), treating as first run.');
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn('Existing data file corrupt, starting fresh:', e.message);
    return null;
  }
}

function mergeVideos(existing, fresh) {
  const merged = new Map();
  for (const v of existing) merged.set(v.id, v);
  for (const v of fresh) merged.set(v.id, v); // fresh wins (newer view counts)
  return Array.from(merged.values()).sort((a, b) =>
    new Date(b.publishedAt) - new Date(a.publishedAt)
  );
}

// --- Main ---

async function main() {
  const startTime = Date.now();
  const existing = loadExistingData();
  const isFirstRun = !existing;

  let sinceDate;
  if (isFirstRun) {
    sinceDate = new Date();
    sinceDate.setUTCFullYear(sinceDate.getUTCFullYear() - HISTORY_YEARS);
    sinceDate.setUTCMonth(0, 1);
    sinceDate.setUTCHours(0, 0, 0, 0);
    console.log(`First run: fetching since ${sinceDate.toISOString().slice(0, 10)}`);
  } else {
    sinceDate = new Date();
    sinceDate.setUTCDate(sinceDate.getUTCDate() - RECENT_WINDOW_DAYS);
    console.log(`Incremental run: refreshing last ${RECENT_WINDOW_DAYS} days (since ${sinceDate.toISOString().slice(0, 10)})`);
  }

  const channel = await resolveChannel();
  console.log(`Channel: ${channel.title} (${channel.id})`);

  const freshVideos = await listVideosFromPlaylist(channel.uploadsPlaylistId, sinceDate);
  if (freshVideos.length === 0) {
    console.log('No videos in window, nothing to update.');
    return;
  }

  await enrichVideos(freshVideos);

  const allVideos = isFirstRun
    ? freshVideos
    : mergeVideos(existing.videos, freshVideos);

  const output = {
    channel: {
      id: channel.id,
      title: channel.title,
      handle: CHANNEL_HANDLE,
      url: `https://www.youtube.com/${CHANNEL_HANDLE}`
    },
    meta: {
      lastUpdated: new Date().toISOString(),
      videoCount: allVideos.length,
      longFormCount: allVideos.filter(v => !v.isShort && !v.unavailable).length,
      shortsCount: allVideos.filter(v => v.isShort && !v.unavailable).length,
      oldestVideoDate: allVideos.length ? allVideos[allVideos.length - 1].publishedAt : null,
      newestVideoDate: allVideos.length ? allVideos[0].publishedAt : null,
      shortsCutoffSec: SHORTS_CUTOFF_SEC
    },
    videos: allVideos
  };

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Done in ${elapsed}s`);
  console.log(`  ${output.meta.videoCount} videos total`);
  console.log(`  ${output.meta.longFormCount} long-form · ${output.meta.shortsCount} shorts`);
  console.log(`  Written to ${DATA_FILE}`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Nightly fetcher for the Quartering universe channels.
 *
 * Modes:
 *
 *   (default) — incremental refresh:
 *     - On first run (no existing data file), fetches everything from HISTORY_YEARS
 *       ago to today for every channel in the CHANNELS list.
 *     - On subsequent runs, only fetches the last 60 days of uploads to catch
 *       new videos and update view counts on recent content.
 *
 *   --backfill — historical backfill:
 *     - Treats the run as a "first run" for fetching purposes (pulls all history
 *       from HISTORY_YEARS ago to today) but merges with existing data so we
 *       don't lose previously-tracked deletion flags / unavailableSince stamps.
 *     - Use when bumping HISTORY_YEARS or adding a channel and you want
 *       deeper history for ALL channels in one shot.
 *
 *   --audit — deletion-detection sweep:
 *     - Reads the existing dataset, re-enriches every video older than RECENT_WINDOW_DAYS
 *       (recent ones are already covered by daily runs), updates view counts and
 *       the `unavailable` flag.
 *     - Does NOT fetch new videos via the uploads playlist.
 *     - Intended to run monthly via a separate workflow to catch deletions of
 *       older videos that fall outside the 60-day refresh window.
 *
 * Required env vars:
 *   YOUTUBE_API_KEY — YouTube Data API v3 key
 *
 * Run:
 *   node scripts/fetch-data.js
 *   node scripts/fetch-data.js --backfill
 *   node scripts/fetch-data.js --audit
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CHANNELS = [
  '@TheQuartering',
  '@JeremyHambly',
  '@UnSleevedMedia',
  '@rcnightmare',
  '@QuarteringLive'
];
const SHORTS_CUTOFF_SEC = 180; // 3 minutes
const RECENT_WINDOW_DAYS = 60; // how far back to refresh on incremental runs
const HISTORY_YEARS = 20; // how far back to fetch on first run / backfill (covers all channels' full histories)
const DATA_FILE = path.join(__dirname, '..', 'public', 'data.json');

const IS_AUDIT = process.argv.includes('--audit');
const IS_BACKFILL = process.argv.includes('--backfill');

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

async function resolveChannel(handle) {
  console.log(`Resolving channel ${handle}...`);
  const url = `https://www.googleapis.com/youtube/v3/channels?part=id,snippet,contentDetails,statistics&forHandle=${encodeURIComponent(handle)}&key=${API_KEY}`;
  const data = await get(url);
  if (!data.items || !data.items.length) throw new Error(`Channel ${handle} not found`);
  const item = data.items[0];
  const stats = item.statistics || {};
  return {
    id: item.id,
    title: item.snippet.title,
    handle,
    url: `https://www.youtube.com/${handle}`,
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
    // Channel-level statistics — captured on every run so we can build
    // a month-over-month delta of total channel views and subscriber count.
    channelViews: parseInt(stats.viewCount || '0', 10),
    subscriberCount: parseInt(stats.subscriberCount || '0', 10)
  };
}

async function listVideosFromPlaylist(playlistId, sinceDate, channelId) {
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
          channelId,
          title: item.snippet.title,
          publishedAt: publishedAt.toISOString()
        });
      }
    }

    console.log(`    Page ${pages}: ${data.items.length} items, ${videos.length} in range so far`);

    if (allOlder && data.items.length > 0) break;
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  return videos;
}

// Parse an engagement count field from the API response.
// Distinguishes "creator has hidden this stat" (returns null) from "zero" (returns 0).
// YouTube omits the field entirely when hidden; we surface that as null rather than 0
// so the site can show "—" instead of misleading "0".
function parseEngagement(statsObj, key) {
  const raw = statsObj && statsObj[key];
  if (raw === undefined || raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function enrichVideos(videos) {
  console.log(`  Fetching duration + view stats for ${videos.length} videos...`);
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
        v.likes = parseEngagement(det.statistics, 'likeCount');
        v.comments = parseEngagement(det.statistics, 'commentCount');
        v.isShort = v.durationSec > 0 && v.durationSec <= SHORTS_CUTOFF_SEC;
        // If a video was previously flagged as unavailable but is now live, clear the flag.
        if (v.unavailable) {
          delete v.unavailable;
          delete v.unavailableSince;
        }
      } else {
        // Video may have been deleted or made private — keep stub
        v.durationSec = 0;
        v.views = 0;
        v.likes = null;
        v.comments = null;
        v.isShort = false;
        v.unavailable = true;
      }
    }
    console.log(`    Enriched ${Math.min(i + 50, videos.length)} / ${videos.length}`);
  }
  return videos;
}

/**
 * Audit-mode enrichment: re-checks the availability of videos older than the
 * RECENT_WINDOW_DAYS window. Updates view counts (since they may have moved
 * meaningfully over months) and the `unavailable` flag. Logs what changed.
 *
 * Differs from enrichVideos:
 * - Doesn't touch publishedAt, title, channelId, id
 * - Tracks transitions and prints a deletion summary at the end
 */
async function auditEnrich(videos) {
  console.log(`  AUDIT: Re-checking ${videos.length} videos for availability...`);
  const newlyUnavailable = [];
  const restoredToLive = [];
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const ids = batch.map(v => v.id).join(',');
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids}&key=${API_KEY}`;
    const data = await get(url);
    const byId = new Map(data.items.map(it => [it.id, it]));
    for (const v of batch) {
      const det = byId.get(v.id);
      const wasUnavailable = !!v.unavailable;
      if (det) {
        v.durationSec = parseDuration(det.contentDetails.duration);
        v.views = parseInt(det.statistics.viewCount || '0', 10);
        v.likes = parseEngagement(det.statistics, 'likeCount');
        v.comments = parseEngagement(det.statistics, 'commentCount');
        v.isShort = v.durationSec > 0 && v.durationSec <= SHORTS_CUTOFF_SEC;
        if (wasUnavailable) {
          delete v.unavailable;
          delete v.unavailableSince;
          restoredToLive.push({ id: v.id, title: v.title });
        }
      } else {
        v.durationSec = v.durationSec || 0;
        v.views = 0;
        v.likes = null;
        v.comments = null;
        v.isShort = false;
        v.unavailable = true;
        if (!wasUnavailable) {
          v.unavailableSince = new Date().toISOString();
          newlyUnavailable.push({ id: v.id, title: v.title, channelId: v.channelId, publishedAt: v.publishedAt });
        }
      }
    }
    console.log(`    Audited ${Math.min(i + 50, videos.length)} / ${videos.length}`);
  }
  return { newlyUnavailable, restoredToLive };
}

function loadExistingData() {
  if (!fs.existsSync(DATA_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed.videos || parsed.videos.length === 0) {
      console.log('Existing data file is empty (placeholder), treating as first run.');
      return null;
    }
    // If the file is in the old single-channel format, migrate by ignoring
    // the old data and treating as a first run. The deep backfill will
    // restore the full history under the new schema.
    if (!parsed.channels && parsed.channel) {
      console.log('Existing data is in old single-channel format, treating as first run for migration.');
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

// Build output JSON from a videos array + channel meta
function buildOutput(allVideos, channelMeta, existing) {
  // Strip internal-only fields from output channel data
  const channelsOut = {};
  for (const id of Object.keys(channelMeta)) {
    const { uploadsPlaylistId, channelViews, subscriberCount, ...publicFields } = channelMeta[id];
    channelsOut[id] = publicFields;

    // Append today's snapshot if we don't already have one for today.
    // (Multiple daily runs would otherwise duplicate snapshots.)
    const today = new Date().toISOString().slice(0, 10);
    const existingSnapshots = existing?.channels?.[id]?.snapshots || [];
    const todayAlreadyCaptured = existingSnapshots.some(s => s.date === today);
    const updatedSnapshots = todayAlreadyCaptured
      ? existingSnapshots.map(s => s.date === today
          ? { date: today, channelViews, subscriberCount }
          : s)
      : [...existingSnapshots, { date: today, channelViews, subscriberCount }];
    // Keep snapshots sorted ascending by date
    updatedSnapshots.sort((a, b) => a.date.localeCompare(b.date));
    channelsOut[id].snapshots = updatedSnapshots;
  }

  // Per-channel meta counts
  for (const id of Object.keys(channelsOut)) {
    const chVids = allVideos.filter(v => v.channelId === id);
    channelsOut[id].meta = {
      videoCount: chVids.length,
      longFormCount: chVids.filter(v => !v.isShort && !v.unavailable).length,
      shortsCount: chVids.filter(v => v.isShort && !v.unavailable).length,
      unavailableCount: chVids.filter(v => v.unavailable).length,
      oldestVideoDate: chVids.length ? chVids[chVids.length - 1].publishedAt : null,
      newestVideoDate: chVids.length ? chVids[0].publishedAt : null
    };
  }

  return {
    channels: channelsOut,
    meta: {
      lastUpdated: new Date().toISOString(),
      videoCount: allVideos.length,
      longFormCount: allVideos.filter(v => !v.isShort && !v.unavailable).length,
      shortsCount: allVideos.filter(v => v.isShort && !v.unavailable).length,
      unavailableCount: allVideos.filter(v => v.unavailable).length,
      oldestVideoDate: allVideos.length ? allVideos[allVideos.length - 1].publishedAt : null,
      newestVideoDate: allVideos.length ? allVideos[0].publishedAt : null,
      shortsCutoffSec: SHORTS_CUTOFF_SEC
    },
    videos: allVideos
  };
}

// --- Main ---

async function main() {
  const startTime = Date.now();

  if (IS_AUDIT) {
    return runAudit(startTime);
  }
  return runIncremental(startTime);
}

async function runIncremental(startTime) {
  const existing = loadExistingData();
  const isFirstRun = !existing;

  // Backfill mode: pretend we have no recent-window optimisation and fetch
  // the full HISTORY_YEARS span — but still merge with existing data so we
  // don't lose unavailable flags or deletion-tracking history. Useful when:
  //   - Adding a new channel (so it gets the full backfill, not just the
  //     "since HISTORY_YEARS ago" default applied to all channels)
  //   - Increasing HISTORY_YEARS and wanting older content backfilled for
  //     channels that already have data
  let sinceDate;
  if (isFirstRun || IS_BACKFILL) {
    sinceDate = new Date();
    sinceDate.setUTCFullYear(sinceDate.getUTCFullYear() - HISTORY_YEARS);
    sinceDate.setUTCMonth(0, 1);
    sinceDate.setUTCHours(0, 0, 0, 0);
    if (IS_BACKFILL && !isFirstRun) {
      console.log(`Backfill run: fetching all uploads since ${sinceDate.toISOString().slice(0, 10)} (full historical refresh, merging with existing data)`);
    } else {
      console.log(`First run: fetching since ${sinceDate.toISOString().slice(0, 10)}`);
    }
  } else {
    sinceDate = new Date();
    sinceDate.setUTCDate(sinceDate.getUTCDate() - RECENT_WINDOW_DAYS);
    console.log(`Incremental run: refreshing last ${RECENT_WINDOW_DAYS} days (since ${sinceDate.toISOString().slice(0, 10)})`);
  }

  // Resolve all channels
  const channelMeta = {};
  for (const handle of CHANNELS) {
    const ch = await resolveChannel(handle);
    channelMeta[ch.id] = {
      id: ch.id,
      title: ch.title,
      handle: ch.handle,
      url: ch.url,
      uploadsPlaylistId: ch.uploadsPlaylistId,
      channelViews: ch.channelViews,
      subscriberCount: ch.subscriberCount
    };
    console.log(`  → ${ch.title} (${ch.id}) · ${ch.channelViews.toLocaleString()} views · ${ch.subscriberCount.toLocaleString()} subs`);
  }

  // Fetch fresh videos for each channel
  let freshVideos = [];
  for (const channelId of Object.keys(channelMeta)) {
    const ch = channelMeta[channelId];
    console.log(`\n[${ch.title}] Listing videos...`);
    const v = await listVideosFromPlaylist(ch.uploadsPlaylistId, sinceDate, channelId);
    if (v.length === 0) {
      console.log(`  No videos in window for ${ch.title}.`);
      continue;
    }
    await enrichVideos(v);
    freshVideos = freshVideos.concat(v);
  }

  if (freshVideos.length === 0 && isFirstRun) {
    console.log('No videos fetched on first run — aborting to avoid writing empty data.');
    return;
  }

  const allVideos = isFirstRun
    ? freshVideos
    : mergeVideos(existing.videos, freshVideos);

  // Sort by date descending
  allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const output = buildOutput(allVideos, channelMeta, existing);

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ Done in ${elapsed}s`);
  console.log(`  ${output.meta.videoCount} videos total across ${Object.keys(output.channels).length} channels`);
  console.log(`  ${output.meta.longFormCount} long-form · ${output.meta.shortsCount} shorts · ${output.meta.unavailableCount} unavailable`);
  for (const id of Object.keys(output.channels)) {
    const ch = output.channels[id];
    const m = ch.meta;
    const snap = ch.snapshots?.[ch.snapshots.length - 1];
    const snapStr = snap ? ` · ${snap.channelViews.toLocaleString()} channel views · ${snap.subscriberCount.toLocaleString()} subs` : '';
    console.log(`    ${ch.title}: ${m.videoCount} (${m.longFormCount} long / ${m.shortsCount} shorts / ${m.unavailableCount} unavailable)${snapStr}`);
  }
  console.log(`  Snapshot history: ${output.channels[Object.keys(output.channels)[0]]?.snapshots?.length || 0} day(s) recorded`);
  console.log(`  Written to ${DATA_FILE}`);
}

async function runAudit(startTime) {
  const existing = loadExistingData();
  if (!existing) {
    console.log('AUDIT: no existing data to audit. Run a normal fetch first.');
    return;
  }

  // We need channel meta with uploadsPlaylistId to write back; re-resolve channels
  console.log('AUDIT: Resolving channels for output metadata...');
  const channelMeta = {};
  for (const handle of CHANNELS) {
    const ch = await resolveChannel(handle);
    channelMeta[ch.id] = {
      id: ch.id,
      title: ch.title,
      handle: ch.handle,
      url: ch.url,
      uploadsPlaylistId: ch.uploadsPlaylistId,
      channelViews: ch.channelViews,
      subscriberCount: ch.subscriberCount
    };
  }

  // Audit scope: all videos older than RECENT_WINDOW_DAYS (recent ones already covered by daily run)
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RECENT_WINDOW_DAYS);
  const auditTargets = existing.videos.filter(v => new Date(v.publishedAt) < cutoff);

  console.log(`AUDIT: Checking ${auditTargets.length} videos older than ${cutoff.toISOString().slice(0, 10)}`);
  console.log(`AUDIT: (${existing.videos.length - auditTargets.length} recent videos skipped — covered by daily runs)`);

  if (auditTargets.length === 0) {
    console.log('AUDIT: no videos to audit. Done.');
    return;
  }

  // Run audit enrichment, capturing deletions and restorations
  const { newlyUnavailable, restoredToLive } = await auditEnrich(auditTargets);

  // Merge audited records back into the full dataset (audit changed objects in-place
  // since they're the same references, but be defensive)
  const auditById = new Map(auditTargets.map(v => [v.id, v]));
  const allVideos = existing.videos.map(v => auditById.get(v.id) || v);
  allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const output = buildOutput(allVideos, channelMeta, existing);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ AUDIT done in ${elapsed}s`);
  console.log(`  Newly unavailable: ${newlyUnavailable.length}`);
  if (newlyUnavailable.length > 0) {
    for (const v of newlyUnavailable.slice(0, 25)) {
      const chTitle = channelMeta[v.channelId]?.title || v.channelId;
      console.log(`    [${chTitle}] ${v.publishedAt.slice(0, 10)} · ${v.title}`);
    }
    if (newlyUnavailable.length > 25) {
      console.log(`    …and ${newlyUnavailable.length - 25} more`);
    }
  }
  console.log(`  Restored to live: ${restoredToLive.length}`);
  if (restoredToLive.length > 0) {
    for (const v of restoredToLive.slice(0, 10)) {
      console.log(`    ${v.title}`);
    }
  }
  console.log(`  Total unavailable across dataset: ${output.meta.unavailableCount}`);
  console.log(`  Written to ${DATA_FILE}`);
}

main().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});

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
// Earliest date on which we believe a sub-3-minute upload could meaningfully
// have been a "Short" in the format sense. YouTube Shorts launched in the US
// (with #Shorts hashtag support) in mid-March 2021, with global rollout in
// July 2021. We use the earlier US date because most of the channels we track
// are US-based and adopted Shorts during the beta period. Videos before this
// were just short videos, not Shorts.
//
// Without this date floor we misclassify a creator's early-career 2-minute
// clips as Shorts, which makes long-form-views aggregates wrong for any
// channel with pre-2021 history.
//
// (We have no direct signal for Shorts in the API — no explicit shorts flag,
// no aspect ratio. Duration-only is a heuristic; date floor improves it for
// old content but doesn't make it perfect.)
const SHORTS_FORMAT_EARLIEST = '2021-03-18';
function isLikelyShort(durationSec, publishedAt) {
  if (!durationSec || durationSec <= 0) return false;
  if (durationSec > SHORTS_CUTOFF_SEC) return false;
  // Compare ISO date strings directly — lexicographic order works for these.
  return (publishedAt || '') >= SHORTS_FORMAT_EARLIEST;
}
const RECENT_WINDOW_DAYS = 60; // how far back to refresh on incremental runs
const HISTORY_YEARS = 20; // how far back to fetch on first run / backfill (covers all channels' full histories)
const DATA_FILE = path.join(__dirname, '..', 'public', 'data.json');
// Descriptions live in a separate file so data.json stays lean (descriptions
// would 4x the raw size, parsed by every page load even though only the
// topic-analysis features actually need them). Loaded on demand by the site.
const DESCRIPTIONS_FILE = path.join(__dirname, '..', 'public', 'descriptions.json');
// Title-change ledger. Records, per video, the first title we saw, the current
// title, and every change in between ({from, to, at, via}). Kept in its own file
// so data.json stays the "current state" and this stays the "history".
const TITLE_HISTORY_FILE = path.join(__dirname, '..', 'public', 'title-history.json');

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
    subscriberCount: parseInt(stats.subscriberCount || '0', 10),
    // YouTube's OWN public-video counter — reconciled against our catalogue
    // every run as a deletion tripwire (see buildOutput). If their count drops
    // below our live count, something vanished that we haven't flagged.
    videoCount: parseInt(stats.videoCount || '0', 10)
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

// Track unlisted state from videos.list part=status. The API returns unlisted
// videos normally (so they look "live" to every other check) — privacyStatus
// is the only per-video signal that a video was quietly delisted from public
// browsing. Private/deleted videos are never returned at all (unavailable path).
function applyPrivacy(v, det, newlyUnlisted) {
  const ps = det.status && det.status.privacyStatus;
  if (ps === 'unlisted') {
    if (!v.unlisted) {
      v.unlistedSince = new Date().toISOString();
      if (newlyUnlisted) newlyUnlisted.push({ id: v.id, title: v.title, channelId: v.channelId });
    }
    v.unlisted = true;
  } else if (ps === 'public' && v.unlisted) {
    delete v.unlisted;
    delete v.unlistedSince;
  }
}

async function enrichVideos(videos, descriptions) {
  console.log(`  Fetching duration + view stats for ${videos.length} videos...`);
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const ids = batch.map(v => v.id).join(',');
    // snippet added for description capture. Cost: 2 quota units/call instead
    // of 1 — still well within daily quota (we run at ~13% utilisation).
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet,status&id=${ids}&key=${API_KEY}`;
    const data = await get(url);
    const byId = new Map(data.items.map(it => [it.id, it]));
    for (const v of batch) {
      const det = byId.get(v.id);
      if (det) {
        v.durationSec = parseDuration(det.contentDetails.duration);
        v.views = parseInt(det.statistics.viewCount || '0', 10);
        v.likes = parseEngagement(det.statistics, 'likeCount');
        v.comments = parseEngagement(det.statistics, 'commentCount');
        v.isShort = isLikelyShort(v.durationSec, v.publishedAt);
        // Capture description to the side-channel map. Stored separately
        // from the video record so it doesn't end up in data.json.
        if (descriptions && det.snippet && det.snippet.description !== undefined) {
          descriptions[v.id] = det.snippet.description;
        }
        applyPrivacy(v, det);
        // If a video was previously flagged as unavailable but is now live, clear the flag.
        if (v.unavailable) {
          delete v.unavailable;
          delete v.unavailableSince;
        }
      } else {
        // Video may have been deleted or made private — keep stub, PRESERVING
        // any last-known stats (the Removed tab renders "last-known views";
        // zeroing here destroys exactly the figure that tab exists to show).
        v.durationSec = v.durationSec || 0;
        v.views = v.views || 0;
        v.likes = v.likes ?? null;
        v.comments = v.comments ?? null;
        v.isShort = !!v.isShort;
        v.unavailable = true;
        v.unavailableSince = v.unavailableSince || new Date().toISOString();
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
 * - Doesn't touch publishedAt, channelId, id
 * - Refreshes the title (and records any change in the title-history ledger) —
 *   this is the path that catches re-titles of videos older than the daily window
 * - Tracks transitions and prints a deletion summary at the end
 */
async function auditEnrich(videos, descriptions, titleHistory) {
  console.log(`  AUDIT: Re-checking ${videos.length} videos for availability...`);
  const newlyUnavailable = [];
  const restoredToLive = [];
  const newlyUnlisted = [];
  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const ids = batch.map(v => v.id).join(',');
    // snippet added so the audit also refreshes descriptions — useful for
    // detecting retroactive edits on older videos (e.g. removing sponsor
    // mentions after a deal sours). Audit runs once daily so this is a
    // small quota cost (~280 units vs ~140 previously).
    const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics,snippet,status&id=${ids}&key=${API_KEY}`;
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
        v.isShort = isLikelyShort(v.durationSec, v.publishedAt);
        if (descriptions && det.snippet && det.snippet.description !== undefined) {
          descriptions[v.id] = det.snippet.description;
        }
        // The audit already fetched the live title here — record any change
        // against the ledger, then bring the stored title up to date so
        // data.json reflects the current title for older videos too.
        if (titleHistory && det.snippet && det.snippet.title) {
          if (recordTitle(titleHistory, v.id, det.snippet.title, 'audit')) {
            const rec = titleHistory[v.id];
            const last = rec.changes[rec.changes.length - 1];
            console.log(`    ⚑ re-titled: "${last.from}" → "${last.to}"`);
          }
          v.title = det.snippet.title;
        }
        applyPrivacy(v, det, newlyUnlisted);
        if (wasUnavailable) {
          delete v.unavailable;
          delete v.unavailableSince;
          restoredToLive.push({ id: v.id, title: v.title });
        }
      } else {
        // Deleted/private — freeze the record as-is. The last-known stats ARE
        // the data (Removed tab shows "last-known views"; isShort must survive
        // so removed Shorts stay Shorts). Only the flag + timestamp change.
        v.durationSec = v.durationSec || 0;
        v.views = v.views || 0;
        v.likes = v.likes ?? null;
        v.comments = v.comments ?? null;
        v.isShort = !!v.isShort;
        v.unavailable = true;
        if (!wasUnavailable) {
          v.unavailableSince = new Date().toISOString();
          newlyUnavailable.push({ id: v.id, title: v.title, channelId: v.channelId, publishedAt: v.publishedAt });
        }
      }
    }
    console.log(`    Audited ${Math.min(i + 50, videos.length)} / ${videos.length}`);
  }
  return { newlyUnavailable, restoredToLive, newlyUnlisted };
}

// Descriptions live in their own file (see DESCRIPTIONS_FILE) and persist
// across runs. The fetcher loads the existing map, refreshes entries for
// the videos it just enriched, prunes entries for videos that no longer
// exist in the dataset, and writes back. Older video descriptions that
// weren't part of this run's refresh window are preserved as-is.
function loadExistingDescriptions() {
  if (!fs.existsSync(DESCRIPTIONS_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE, 'utf8'));
    return parsed.descriptions || {};
  } catch (e) {
    console.log(`Could not parse existing descriptions file (${e.message}); starting fresh.`);
    return {};
  }
}

function writeDescriptions(descriptions, validVideoIds) {
  // Prune descriptions for videos that are no longer in the dataset at all
  // (deleted entirely, never seen). Unavailable-flagged videos are still in
  // the dataset — their last-known descriptions stay until they fall out
  // of the videos array entirely.
  const valid = new Set(validVideoIds);
  const pruned = {};
  for (const [id, desc] of Object.entries(descriptions)) {
    if (valid.has(id)) pruned[id] = desc;
  }
  const output = {
    lastUpdated: new Date().toISOString(),
    descriptions: pruned
  };
  fs.mkdirSync(path.dirname(DESCRIPTIONS_FILE), { recursive: true });
  fs.writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(output));
  console.log(`  Descriptions: ${Object.keys(pruned).length} entries written to ${DESCRIPTIONS_FILE}`);
}

// --- Title-change tracking ---

// Load the existing ledger, or seed a fresh one from the current dataset so we
// have a baseline title for every video already on record. Seeding only happens
// once (when title-history.json doesn't yet exist); after that it's loaded and
// appended to. The seed's "first"/"current" is whatever title data.json holds
// at adoption time — honest as "what we had on record when tracking started".
function loadOrSeedTitleHistory(existing) {
  if (fs.existsSync(TITLE_HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TITLE_HISTORY_FILE, 'utf8')).videos || {};
    } catch (e) {
      console.log(`Could not parse title-history (${e.message}); reseeding from current data.`);
    }
  }
  const seeded = {};
  if (existing && existing.videos) {
    for (const v of existing.videos) {
      if (v.title) seeded[v.id] = { first: v.title, current: v.title, changes: [] };
    }
    console.log(`  Title history: seeding baseline from ${Object.keys(seeded).length} existing videos.`);
  }
  return seeded;
}

// Record an observed (freshly-fetched) title against the ledger. First sighting
// of a video seeds it with no change logged; an observed title that differs from
// what we last had on record logs a {from, to, at, via} entry and advances
// "current". Returns true iff a change was logged.
function recordTitle(history, id, observedTitle, via) {
  if (!observedTitle) return false;
  const rec = history[id];
  if (!rec) {
    history[id] = { first: observedTitle, current: observedTitle, changes: [] };
    return false;
  }
  if (observedTitle !== rec.current) {
    rec.changes.push({ from: rec.current, to: observedTitle, at: new Date().toISOString(), via });
    rec.current = observedTitle;
    return true;
  }
  return false;
}

function writeTitleHistory(history, validVideoIds) {
  const valid = new Set(validVideoIds);
  const pruned = {};
  for (const [id, rec] of Object.entries(history)) {
    if (valid.has(id)) pruned[id] = rec;
  }
  const totalChanges = Object.values(pruned).reduce((n, r) => n + (r.changes ? r.changes.length : 0), 0);
  const changed = Object.values(pruned).filter(r => r.changes && r.changes.length).length;
  const output = {
    _generated: new Date().toISOString(),
    _videosTracked: Object.keys(pruned).length,
    _videosRetitled: changed,
    _totalChanges: totalChanges,
    videos: pruned
  };
  fs.mkdirSync(path.dirname(TITLE_HISTORY_FILE), { recursive: true });
  fs.writeFileSync(TITLE_HISTORY_FILE, JSON.stringify(output, null, 2));
  console.log(`  Title history: ${Object.keys(pruned).length} tracked · ${changed} ever re-titled · ${totalChanges} total change(s) → ${TITLE_HISTORY_FILE}`);
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
    const { uploadsPlaylistId, channelViews, subscriberCount, videoCount, ...publicFields } = channelMeta[id];
    channelsOut[id] = publicFields;

    // Append today's snapshot if we don't already have one for today.
    // (Multiple daily runs would otherwise duplicate snapshots.)
    const today = new Date().toISOString().slice(0, 10);
    const existingSnapshots = existing?.channels?.[id]?.snapshots || [];
    const todayAlreadyCaptured = existingSnapshots.some(s => s.date === today);
    const updatedSnapshots = todayAlreadyCaptured
      ? existingSnapshots.map(s => s.date === today
          ? { date: today, channelViews, subscriberCount, videoCount }
          : s)
      : [...existingSnapshots, { date: today, channelViews, subscriberCount, videoCount }];
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
      unlistedCount: chVids.filter(v => v.unlisted && !v.unavailable).length,
      oldestVideoDate: chVids.length ? chVids[chVids.length - 1].publishedAt : null,
      newestVideoDate: chVids.length ? chVids[0].publishedAt : null
    };
    // Deletion tripwire: reconcile YouTube's OWN public-video counter against
    // our catalogued live count. Their counter excludes unlisted/private, so:
    //   yt > ours  → benign (uploads we haven't fetched yet, or history deeper
    //                than our backfill window)
    //   yt < ours  → something we still count as live is no longer public
    //                (deleted, privated, or UNLISTED — the case the per-video
    //                checks can't see) and hasn't been flagged yet.
    const ytCount = channelMeta[id].videoCount;
    if (ytCount > 0) {
      // YT's counter is PUBLIC videos only, so compare against our live count
      // minus the videos we already know are unlisted — any remaining shortfall
      // is an unflagged removal/delisting.
      const ourPublic = chVids.length - channelsOut[id].meta.unavailableCount - channelsOut[id].meta.unlistedCount;
      channelsOut[id].meta.ytVideoCount = ytCount;
      if (ytCount < ourPublic) {
        console.log(`  ⚠ RECONCILE ${channelMeta[id].handle}: YouTube reports ${ytCount} public videos but we count ${ourPublic} public — ${ourPublic - ytCount} likely deleted/privated/unlisted and not yet flagged`);
      }
    }
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
  const descriptions = loadExistingDescriptions();
  const titleHistory = loadOrSeedTitleHistory(existing);
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
      subscriberCount: ch.subscriberCount,
      videoCount: ch.videoCount
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
    await enrichVideos(v, descriptions);
    freshVideos = freshVideos.concat(v);
  }

  if (freshVideos.length === 0 && isFirstRun) {
    console.log('No videos fetched on first run — aborting to avoid writing empty data.');
    return;
  }

  // Detect title changes. Each fresh record carries the live title from the
  // playlist snippet; compare against what we last had on record. On a normal
  // incremental run this covers the last-60-days window; on a --backfill it
  // covers the entire catalogue in one pass (the way to catch up on every
  // re-title of older videos that the daily window never revisits).
  let titleChanges = 0;
  const via = IS_BACKFILL ? 'backfill' : 'incremental';
  for (const v of freshVideos) {
    if (recordTitle(titleHistory, v.id, v.title, via)) {
      titleChanges++;
      const rec = titleHistory[v.id];
      const last = rec.changes[rec.changes.length - 1];
      console.log(`  ⚑ re-titled: "${last.from}" → "${last.to}"`);
    }
  }
  if (titleChanges > 0) console.log(`\n⚑ ${titleChanges} title change(s) detected this run.`);

  // --- Recent-deletion sweep (incremental only) --------------------------
  // The daily audit only re-checks videos OLDER than the window, and the
  // incremental listing only returns currently-live uploads — so a video
  // deleted/privated while still inside the recent window would silently drop
  // out of the listing and never get flagged (caught only ~60 days later when
  // it ages into the audit). Close that gap: any stored in-window video missing
  // from this run's live listing is re-verified by id (auditEnrich confirms via
  // the API, so a playlist-listing fluke won't false-positive) and flagged
  // unavailable with an accurate unavailableSince if it's genuinely gone.
  // Wrapped so a hiccup here can never break the core data refresh.
  if (!isFirstRun && !IS_BACKFILL && existing && existing.videos) {
    try {
      const freshIds = new Set(freshVideos.map(v => v.id));
      const recentMissing = existing.videos.filter(v =>
        !freshIds.has(v.id) && new Date(v.publishedAt) >= sinceDate);
      if (recentMissing.length) {
        console.log(`\nRecent-deletion check: ${recentMissing.length} in-window video(s) missing from the live listing — re-verifying via API...`);
        const { newlyUnavailable, restoredToLive, newlyUnlisted } = await auditEnrich(recentMissing, descriptions, titleHistory);
        if (newlyUnavailable.length) {
          console.log(`  ⚑ ${newlyUnavailable.length} newly unavailable (deleted/private):`);
          for (const v of newlyUnavailable.slice(0, 25)) console.log(`    - ${v.title} (${v.channelId}, ${v.publishedAt.slice(0, 10)})`);
        } else {
          console.log(`  All ${recentMissing.length} still live via API — a listing gap, not deletions.`);
        }
        if (restoredToLive.length) console.log(`  ↺ ${restoredToLive.length} restored to live.`);
        if (newlyUnlisted.length) console.log(`  ⚑ ${newlyUnlisted.length} newly UNLISTED (delisted from public browsing): ` + newlyUnlisted.map(v => v.title).join(' | '));
      }
    } catch (e) {
      console.warn('  Recent-deletion check failed (non-fatal):', e.message);
    }
  }

  const allVideos = isFirstRun
    ? freshVideos
    : mergeVideos(existing.videos, freshVideos);

  // Sort by date descending
  allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const output = buildOutput(allVideos, channelMeta, existing);

  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  writeDescriptions(descriptions, allVideos.map(v => v.id));
  writeTitleHistory(titleHistory, allVideos.map(v => v.id));

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
  const descriptions = loadExistingDescriptions();
  const titleHistory = loadOrSeedTitleHistory(existing);
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
      subscriberCount: ch.subscriberCount,
      videoCount: ch.videoCount
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
  const { newlyUnavailable, restoredToLive, newlyUnlisted } = await auditEnrich(auditTargets, descriptions, titleHistory);

  // Merge audited records back into the full dataset (audit changed objects in-place
  // since they're the same references, but be defensive)
  const auditById = new Map(auditTargets.map(v => [v.id, v]));
  const allVideos = existing.videos.map(v => auditById.get(v.id) || v);
  allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const output = buildOutput(allVideos, channelMeta, existing);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  writeDescriptions(descriptions, allVideos.map(v => v.id));
  writeTitleHistory(titleHistory, allVideos.map(v => v.id));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✓ AUDIT done in ${elapsed}s`);
  console.log(`  Newly UNLISTED: ${newlyUnlisted.length}`);
  for (const v of newlyUnlisted.slice(0, 25)) console.log(`    - ${v.title} (${v.channelId})`);
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

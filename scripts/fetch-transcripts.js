#!/usr/bin/env node
/**
 * Transcript fetcher — pulls auto-caption transcripts from YouTube for every
 * video in data.json and stores them in a private sister repo.
 *
 * Three modes:
 *   --backfill         every video not yet fetched (newest-first)
 *   --incremental      only videos uploaded in the last 30 days, capped at
 *                      100 per run; intended for the daily cron
 *   --retry-failures   reattempt videos in failures.json (private/deleted/
 *                      no-captions videos; some recover, most don't)
 *
 * Storage layout in sister repo:
 *   transcripts/<videoId>.json     full transcript + metadata, per video
 *   index.json                     fetched/failure status per video ID
 *
 * Resumability: progress is committed in batches of 100 videos. If the
 * runner dies mid-backfill (timeout, network blip, etc.) the next invocation
 * clones the sister repo, sees what's already done via index.json, and
 * picks up from there. No state is held in /tmp beyond a single run.
 *
 * Required env:
 *   TRANSCRIPTS_REPO_TOKEN   fine-grained PAT with write to sister repo
 *   TRANSCRIPTS_REPO         e.g. "jerminaldecline/jerminaldecline-transcripts"
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { YoutubeTranscript } = require('youtube-transcript');

const DATA_FILE = path.join(__dirname, '..', 'public', 'data.json');
const SISTER_REPO = process.env.TRANSCRIPTS_REPO || 'jerminaldecline/jerminaldecline-transcripts';
const SISTER_PATH = '/tmp/transcripts-repo';
const TOKEN = process.env.TRANSCRIPTS_REPO_TOKEN;

// Tunables — chosen based on Phase 1 measurements (~350ms per fetch).
const FETCH_DELAY_MS = 500;         // polite delay between fetches
const COMMIT_BATCH_SIZE = 100;       // commit progress every N videos
const MAX_RUNTIME_MIN = 300;         // 5h soft limit; below 6h GH Actions cap
const INCREMENTAL_WINDOW_DAYS = 30;  // incremental looks back this far
const INCREMENTAL_MAX_VIDEOS = 100;  // safety cap per incremental run
const FAILURE_STREAK_BAIL = 20;      // bail if this many fail in a row
                                     // (catches "youtube blocked us" scenarios)

const IS_BACKFILL = process.argv.includes('--backfill');
const IS_INCREMENTAL = process.argv.includes('--incremental');
const IS_RETRY = process.argv.includes('--retry-failures');

if (!TOKEN) {
  console.error('Missing TRANSCRIPTS_REPO_TOKEN env var');
  process.exit(1);
}
if (!IS_BACKFILL && !IS_INCREMENTAL && !IS_RETRY) {
  console.error('Pass one of: --backfill, --incremental, --retry-failures');
  process.exit(1);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'pipe', ...opts }).toString();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cloneSisterRepo() {
  if (fs.existsSync(SISTER_PATH)) {
    run(`rm -rf ${SISTER_PATH}`);
  }
  const cloneUrl = `https://x-access-token:${TOKEN}@github.com/${SISTER_REPO}.git`;
  run(`git clone --depth 1 ${cloneUrl} ${SISTER_PATH}`);
  run('git config user.name "github-actions[bot]"', { cwd: SISTER_PATH });
  run('git config user.email "github-actions[bot]@users.noreply.github.com"', { cwd: SISTER_PATH });
}

function loadIndex() {
  const p = path.join(SISTER_PATH, 'index.json');
  if (fs.existsSync(p)) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      console.warn(`Could not parse index.json (${e.message}); starting fresh`);
    }
  }
  return { fetched: {}, failures: {} };
}

function saveIndex(index) {
  const p = path.join(SISTER_PATH, 'index.json');
  fs.writeFileSync(p, JSON.stringify(index, null, 2));
}

function writeTranscript(video, segments) {
  const dir = path.join(SISTER_PATH, 'transcripts');
  fs.mkdirSync(dir, { recursive: true });
  // Store full segment data (text + offset + duration) so we keep the option
  // to do timestamp-aware work later (e.g. "what time does the sponsor read
  // start", "which 30s window covers this phrase"). Title and publishedAt are
  // denormalised here so a transcript file is self-contained for analysis.
  const out = {
    videoId: video.id,
    channelId: video.channelId,
    title: video.title,
    publishedAt: video.publishedAt,
    fetchedAt: new Date().toISOString(),
    segments
  };
  fs.writeFileSync(path.join(dir, `${video.id}.json`), JSON.stringify(out));
}

function commitProgress(message) {
  run('git add -A', { cwd: SISTER_PATH });
  // diff --staged --quiet exits non-zero if there ARE changes.
  try {
    run('git diff --staged --quiet', { cwd: SISTER_PATH });
    return; // no staged changes
  } catch {
    // staged changes exist — proceed to commit
  }
  // execSync with double-quoted args; escape any quotes in message
  const safeMessage = message.replace(/"/g, '\\"');
  run(`git commit -m "${safeMessage}"`, { cwd: SISTER_PATH });
  // Push with retry — in practice nothing else writes here but be defensive
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      run('git push', { cwd: SISTER_PATH });
      return;
    } catch (e) {
      console.log(`  push failed (attempt ${attempt}); pulling and retrying...`);
      try { run('git pull --rebase', { cwd: SISTER_PATH }); }
      catch { /* might fail if no remote changes; ignore */ }
    }
  }
  throw new Error('push failed after 3 attempts');
}

async function fetchOne(videoId) {
  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId);
    if (!Array.isArray(segments) || segments.length === 0) {
      return { ok: false, error: 'Empty transcript returned' };
    }
    return { ok: true, segments };
  } catch (e) {
    // Truncate to keep failures.json compact
    return { ok: false, error: (e.message || String(e)).slice(0, 200) };
  }
}

function selectTargets(data, index) {
  const allVideos = (data.videos || []).filter(v => v.id && !v.unavailable);

  if (IS_RETRY) {
    return allVideos.filter(v => index.failures[v.id]);
  }

  if (IS_INCREMENTAL) {
    const cutoff = Date.now() - INCREMENTAL_WINDOW_DAYS * 86400000;
    const targets = allVideos.filter(v => {
      if (index.fetched[v.id]) return false;
      if (index.failures[v.id]) return false;
      return new Date(v.publishedAt).getTime() >= cutoff;
    });
    // Newest first so brand-new uploads get covered before the runner times out
    targets.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return targets.slice(0, INCREMENTAL_MAX_VIDEOS);
  }

  // Backfill: every unfetched, non-previously-failed video.
  // Newest-first because (a) recent videos are most editorially relevant,
  // (b) most likely to have captions, (c) means a partial backfill still
  // gives us useful coverage of the live story.
  const targets = allVideos.filter(v => {
    if (index.fetched[v.id]) return false;
    if (index.failures[v.id]) return false;
    return true;
  });
  targets.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return targets;
}

async function main() {
  const startTime = Date.now();
  const maxRuntime = MAX_RUNTIME_MIN * 60 * 1000;

  const mode = IS_BACKFILL ? 'BACKFILL'
             : IS_INCREMENTAL ? 'INCREMENTAL'
             : 'RETRY-FAILURES';
  console.log(`Mode: ${mode}\n`);

  console.log(`Cloning sister repo ${SISTER_REPO}...`);
  cloneSisterRepo();

  const index = loadIndex();
  console.log(`Index: ${Object.keys(index.fetched).length} fetched, ${Object.keys(index.failures).length} failures`);

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`data.json not found at ${DATA_FILE}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  console.log(`data.json: ${data.videos.length} videos total`);

  const targets = selectTargets(data, index);
  console.log(`Targets for this run: ${targets.length}\n`);

  if (targets.length === 0) {
    console.log('Nothing to do. Exiting.');
    return;
  }

  let succeeded = 0;
  let failed = 0;
  let processed = 0;
  let streakFails = 0;
  let lastCommitAt = 0;

  for (const video of targets) {
    if (Date.now() - startTime > maxRuntime) {
      console.log(`\nSoft time limit reached (${MAX_RUNTIME_MIN}min). Committing and stopping.`);
      break;
    }

    if (streakFails >= FAILURE_STREAK_BAIL) {
      console.log(`\n${FAILURE_STREAK_BAIL} consecutive failures — looks like we're being blocked. Bailing out.`);
      break;
    }

    const idx = processed + 1;
    process.stdout.write(`[${idx}/${targets.length}] ${video.id} ${video.publishedAt.slice(0, 10)} ... `);

    const result = await fetchOne(video.id);

    if (result.ok) {
      writeTranscript(video, result.segments);
      const fullText = result.segments.map(s => s.text || '').join(' ');
      index.fetched[video.id] = {
        fetchedAt: new Date().toISOString(),
        segmentCount: result.segments.length,
        charCount: fullText.length
      };
      if (index.failures[video.id]) delete index.failures[video.id];
      console.log(`OK (${result.segments.length} segs, ${fullText.length} chars)`);
      succeeded++;
      streakFails = 0;
    } else {
      index.failures[video.id] = {
        lastTried: new Date().toISOString(),
        error: result.error
      };
      console.log(`FAIL: ${result.error}`);
      failed++;
      streakFails++;
    }

    processed++;

    if (processed - lastCommitAt >= COMMIT_BATCH_SIZE) {
      saveIndex(index);
      const batchN = Math.floor(processed / COMMIT_BATCH_SIZE);
      console.log(`  -- committing batch ${batchN} (${succeeded} new, ${failed} failed so far)`);
      commitProgress(`transcripts: batch ${batchN} (${succeeded} new)`);
      lastCommitAt = processed;
    }

    await sleep(FETCH_DELAY_MS);
  }

  // Final commit for the trailing partial batch
  if (processed > lastCommitAt) {
    saveIndex(index);
    console.log('\nFinal commit...');
    commitProgress(`transcripts: final (${succeeded} new, ${failed} failed)`);
  }

  console.log(`\nDone: ${processed} processed, ${succeeded} succeeded, ${failed} failed`);
  const elapsedSec = (Date.now() - startTime) / 1000;
  const perVideo = processed > 0 ? (elapsedSec / processed).toFixed(2) : '0';
  console.log(`Total time: ${elapsedSec.toFixed(1)}s (avg ${perVideo}s per video)`);
}

main().catch(e => {
  console.error('Script crashed:', e);
  process.exit(1);
});

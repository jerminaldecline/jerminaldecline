#!/usr/bin/env node
/**
 * Topic tagger v2 — assigns a primary topic to each TQ long-form video using
 * title + description + transcript as scoring inputs.
 *
 * v2 changes from v1:
 *   - Now reads public/descriptions.json (was: transcript only)
 *   - Uses video.title from data.json (was: ignored)
 *   - Weights matches per source: title 3x, description 1.5x, transcript 1x
 *     (titles are dense semantic signals — "Brie Larson DEMOLISHED!" is a
 *     stronger indicator than 3 transcript mentions of "brie larson")
 *   - Videos with no transcript can still be tagged from title+description
 *     (recovers ~170 videos with disabled captions)
 *
 * Output schema unchanged — site code doesn't need updates:
 *   public/topic-tags.json: { _generated, _topicsHash, _stats, tags: {videoId: topicId} }
 *
 * Run:
 *   node scripts/tag-topics.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'public', 'data.json');
const DESCRIPTIONS_FILE = path.join(__dirname, '..', 'public', 'descriptions.json');
const TOPICS_FILE = path.join(__dirname, '..', 'public', 'topics.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'public', 'topic-tags.json');
const OVERRIDES_FILE = path.join(__dirname, '..', 'public', 'topic-tag-overrides.json');
const TRANSCRIPTS_PATH = process.env.TRANSCRIPTS_PATH || 'C:/tmp/transcripts-repo/transcripts';

// Channels to tag. Add more as patterns emerge — topic taxonomy can be shared
// across channels with similar editorial focus (TQ family + Jeremy Hambly run
// in adjacent content spaces).
const CHANNELS_TO_TAG = [
  'UCfwE_ODI1YTbdjkzuSi1Nag', // TheQuartering
  'UCEOtZuVe8emWLKRzJIkzVow', // JeremyHambly
  'UCYtHYzxsUH_QCZtrldLMyUg'  // QuarteringLive
];

// Minimum total weighted score for a topic to claim primary tag.
// At weights title=3, desc=1.5, transcript=1, a video with EITHER:
//   - 1 title mention (3) → passes
//   - 2 desc mentions (3) → passes
//   - 3 transcript mentions (3) → passes
//   - Any reasonable combo of two sources → easily passes
const MIN_PRIMARY_SCORE = 3;

// Per-source weights
const W_TITLE = 3;
const W_DESC = 1.5;
const W_TRANSCRIPT = 1;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadTopics() {
  if (!fs.existsSync(TOPICS_FILE)) {
    console.error(`Topics taxonomy not found at ${TOPICS_FILE}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(TOPICS_FILE, 'utf8');
  const json = JSON.parse(raw);
  const topics = {};
  for (const [id, def] of Object.entries(json)) {
    if (id.startsWith('_')) continue;
    if (!def || !Array.isArray(def.keywords) || def.keywords.length === 0) {
      console.warn(`Topic ${id} has no keywords, skipping`);
      continue;
    }
    topics[id] = def;
  }
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return { topics, hash };
}

function compileRegexes(topics) {
  const out = {};
  for (const [id, topic] of Object.entries(topics)) {
    out[id] = topic.keywords.map(k =>
      new RegExp('\\b' + escapeRegex(k) + '\\b', 'gi')
    );
  }
  return out;
}

function countMatches(text, regexes) {
  if (!text) return 0;
  let count = 0;
  for (const re of regexes) {
    const matches = text.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

function scoreTopic(titleText, descText, transcriptText, regexes) {
  const titleHits = countMatches(titleText, regexes);
  const descHits = countMatches(descText, regexes);
  const transcriptHits = countMatches(transcriptText, regexes);
  const titleScore = titleHits * W_TITLE;
  const totalScore = titleScore + descHits * W_DESC + transcriptHits * W_TRANSCRIPT;
  return { titleScore, totalScore };
}

function pickPrimary(scores) {
  // Title-dominant rule: among topics whose total weighted score meets the
  // threshold, prefer the topic with the highest TITLE score (i.e. the topic
  // most strongly signaled in the title). Ties broken by total score, then
  // by topic ID for stability.
  //
  // Why: title-keywords are intentional editorial choices about what a video
  // is "about". Body matches are supporting context that can pile up
  // misleadingly when a broad-keyword topic (e.g. fast-food with 50+ chain
  // names) racks up incidental references. Without this rule, a "BLACK
  // FATIGUE DESTROYED" video that happens to discuss a restaurant gets
  // mis-tagged as fast-food because the restaurant gets mentioned 20+ times.
  const candidates = Object.entries(scores)
    .filter(([_, s]) => s.totalScore >= MIN_PRIMARY_SCORE)
    .sort((a, b) => {
      if (b[1].titleScore !== a[1].titleScore) return b[1].titleScore - a[1].titleScore;
      if (b[1].totalScore !== a[1].totalScore) return b[1].totalScore - a[1].totalScore;
      return a[0].localeCompare(b[0]);
    });
  return candidates.length > 0 ? candidates[0][0] : null;
}

function main() {
  console.log(`Loading taxonomy from ${TOPICS_FILE}...`);
  const { topics, hash } = loadTopics();
  console.log(`  ${Object.keys(topics).length} topics defined (taxonomy hash ${hash})`);
  const topicRegexes = compileRegexes(topics);

  console.log(`Loading data.json...`);
  if (!fs.existsSync(DATA_FILE)) {
    console.error('data.json not found');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  console.log(`Loading descriptions.json...`);
  let descriptions = {};
  if (fs.existsSync(DESCRIPTIONS_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE, 'utf8'));
    // fetch-data.js writes { lastUpdated, descriptions: {...} } — extract the
    // inner map. Fall back to top-level if a legacy bare-map file is present.
    descriptions = parsed.descriptions || parsed;
  } else {
    console.warn('  descriptions.json not found — proceeding without descriptions');
  }

  // Load per-video manual overrides — videos pinned to a specific topic, applied
  // AFTER scoring. Used for videos where TQ uses euphemistic language (e.g.
  // saying "fatigue" alone instead of "black fatigue" to dodge YT auto-flagging)
  // and the keyword scorer can't catch them via signal strength alone.
  // Value can also be null to force-untag a video the scorer over-claimed.
  let overrides = {};
  if (fs.existsSync(OVERRIDES_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
      overrides = parsed.overrides || {};
      console.log(`Loaded ${Object.keys(overrides).length} per-video overrides`);
    } catch (e) {
      console.warn(`  Could not parse overrides file: ${e.message}`);
    }
  }

  const targets = data.videos.filter(v =>
    CHANNELS_TO_TAG.includes(v.channelId) && !v.isShort && !v.unavailable
  );
  console.log(`${targets.length} long-form videos to tag across ${CHANNELS_TO_TAG.length} channels\n`);

  const transcriptsAvailable = fs.existsSync(TRANSCRIPTS_PATH);
  if (!transcriptsAvailable) {
    console.warn(`Transcripts directory not found at ${TRANSCRIPTS_PATH}`);
    console.warn('Tagging will use title + description only.\n');
  }

  const tags = {};
  let processed = 0;
  let tagged = 0;
  let untagged = 0;
  let withTranscript = 0;
  let withoutTranscript = 0;
  let overrideApplied = 0;
  let overrideRemovedTag = 0;
  const perTopicCount = {};
  for (const id of Object.keys(topics)) perTopicCount[id] = 0;

  for (const video of targets) {
    const titleText = (video.title || '').toLowerCase();
    const descText = (descriptions[video.id] || '').toLowerCase();

    let transcriptText = '';
    if (transcriptsAvailable) {
      const transcriptPath = path.join(TRANSCRIPTS_PATH, `${video.id}.json`);
      if (fs.existsSync(transcriptPath)) {
        try {
          const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
          transcriptText = (transcript.segments || [])
            .map(s => (s.text || '').toLowerCase())
            .join(' ');
          withTranscript++;
        } catch (e) {
          withoutTranscript++;
        }
      } else {
        withoutTranscript++;
      }
    } else {
      withoutTranscript++;
    }

    // Score every topic
    const scores = {};
    for (const id of Object.keys(topics)) {
      const s = scoreTopic(titleText, descText, transcriptText, topicRegexes[id]);
      if (s.totalScore > 0) scores[id] = s;
    }

    let primary = pickPrimary(scores);

    // Manual override: pinned video → topic mapping, applied last. null forces
    // untagged (useful for over-claimed false positives spotted in the wild).
    if (Object.prototype.hasOwnProperty.call(overrides, video.id)) {
      const forced = overrides[video.id];
      if (forced === null) {
        if (primary !== null) overrideRemovedTag++;
        primary = null;
      } else if (topics[forced]) {
        if (primary !== forced) overrideApplied++;
        primary = forced;
      } else {
        console.warn(`  Override for ${video.id} → "${forced}" but topic not in topics.json; ignoring`);
      }
    }

    if (primary) {
      tags[video.id] = primary;
      perTopicCount[primary]++;
      tagged++;
    } else {
      untagged++;
    }

    processed++;
    if (processed % 1000 === 0) {
      console.log(`  ${processed} / ${targets.length} processed`);
    }
  }

  console.log(`\nResults:`);
  console.log(`  Tagged:                  ${tagged}`);
  console.log(`  Untagged:                ${untagged}`);
  console.log(`  With transcript:         ${withTranscript}`);
  console.log(`  Without transcript:      ${withoutTranscript}`);
  if (overrideApplied || overrideRemovedTag) {
    console.log(`  Overrides applied:       ${overrideApplied} (changed/added a tag)`);
    console.log(`  Overrides force-untagged: ${overrideRemovedTag}`);
  }

  const output = {
    _generated: new Date().toISOString(),
    _topicsHash: hash,
    _taggerVersion: 'v3-title-dominant',
    _stats: {
      tagged,
      untagged,
      withTranscript,
      withoutTranscript,
      totalTargets: targets.length,
      weights: { title: W_TITLE, description: W_DESC, transcript: W_TRANSCRIPT },
      minPrimaryScore: MIN_PRIMARY_SCORE
    },
    tags
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  console.log(`\nWrote ${OUTPUT_FILE}`);

  console.log(`\nPer-topic tag counts:`);
  const sorted = Object.entries(perTopicCount)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [id, count] of sorted) {
    const name = topics[id].name;
    console.log(`  ${count.toString().padStart(5)}  ${id.padEnd(28)} ${name}`);
  }
}

main();

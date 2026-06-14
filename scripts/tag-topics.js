/**
 * Topic tagger — assigns a primary topic to each TQ long-form video based on
 * keyword matches in its transcript. Writes results to a separate file
 * (topic-tags.json) so the daily data-update workflow can keep overwriting
 * data.json without losing tags.
 *
 * Tags are keyed by video ID:
 *   {
 *     "_generated": "2026-06-14T...",
 *     "_topicsVersion": "<sha256 of topics.json contents>",
 *     "_stats": { tagged, untagged, missingTranscript, ... },
 *     "tags": {
 *       "abc123": "karmelo-anthony",
 *       "def456": "trump",
 *       ...
 *     }
 *   }
 *
 * The site fetches both data.json and topic-tags.json and joins them in
 * memory at render time.
 *
 * Inputs:
 *   ../public/data.json                         video metadata
 *   ../public/topics.json                       canonical taxonomy
 *   /tmp/transcripts-repo/transcripts (default) transcript JSON files
 *
 * Output:
 *   ../public/topic-tags.json
 *
 * Override transcripts path:
 *   $env:TRANSCRIPTS_PATH = "C:\\path\\to\\transcripts"
 *
 * Run:
 *   node scripts/tag-topics.js
 *
 * Typical runtime: 3-5 minutes on ~9000 TQ long-form transcripts.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'public', 'data.json');
const TOPICS_FILE = path.join(__dirname, '..', 'public', 'topics.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'public', 'topic-tags.json');
const TRANSCRIPTS_PATH = process.env.TRANSCRIPTS_PATH || 'C:/tmp/transcripts-repo/transcripts';
const TQ_CHANNEL = 'UCfwE_ODI1YTbdjkzuSi1Nag';

// Minimum total keyword matches for a topic to be eligible as primary.
// Below this, the video is left untagged. Match what was used in the scan.
const MIN_PRIMARY_MATCHES = 3;

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
    if (id.startsWith('_')) continue; // skip _comment etc.
    if (!def || !Array.isArray(def.keywords) || def.keywords.length === 0) {
      console.warn(`Topic ${id} has no keywords, skipping`);
      continue;
    }
    topics[id] = def;
  }
  // Hash for tracking which taxonomy version produced these tags
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

function scoreVideo(text, topicRegexes) {
  // Returns { topicId: score } for all topics with at least 1 match.
  const scores = {};
  for (const [id, regexes] of Object.entries(topicRegexes)) {
    let total = 0;
    for (const re of regexes) {
      const matches = text.match(re);
      if (matches) total += matches.length;
    }
    if (total > 0) scores[id] = total;
  }
  return scores;
}

function pickPrimary(scores) {
  // Topic with highest score above MIN_PRIMARY_MATCHES wins. Ties broken
  // by lexical ordering of topic ID (stable, deterministic).
  let primary = null;
  let primaryScore = MIN_PRIMARY_MATCHES - 1;
  for (const [id, score] of Object.entries(scores)) {
    if (score > primaryScore) {
      primaryScore = score;
      primary = id;
    } else if (score === primaryScore && primary !== null) {
      // Deterministic tie-break
      if (id < primary) primary = id;
    }
  }
  return primary;
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

  // Long-form TQ only, available videos
  const targets = data.videos.filter(v =>
    v.channelId === TQ_CHANNEL && !v.isShort && !v.unavailable
  );
  console.log(`${targets.length} TQ long-form videos to tag\n`);

  if (!fs.existsSync(TRANSCRIPTS_PATH)) {
    console.error(`Transcripts not found at ${TRANSCRIPTS_PATH}`);
    process.exit(1);
  }

  const tags = {};
  let processed = 0;
  let tagged = 0;
  let untagged = 0;
  let missingTranscript = 0;
  const perTopicCount = {};
  for (const id of Object.keys(topics)) perTopicCount[id] = 0;

  for (const video of targets) {
    const transcriptPath = path.join(TRANSCRIPTS_PATH, `${video.id}.json`);
    if (!fs.existsSync(transcriptPath)) {
      missingTranscript++;
      continue;
    }

    let transcript;
    try {
      transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
    } catch (e) {
      missingTranscript++;
      continue;
    }

    const fullText = (transcript.segments || [])
      .map(s => (s.text || '').toLowerCase())
      .join(' ');

    const scores = scoreVideo(fullText, topicRegexes);
    const primary = pickPrimary(scores);

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
  console.log(`  Tagged:             ${tagged}`);
  console.log(`  Untagged:           ${untagged}`);
  console.log(`  Missing transcript: ${missingTranscript}`);

  // Write output
  const output = {
    _generated: new Date().toISOString(),
    _topicsHash: hash,
    _stats: {
      tagged,
      untagged,
      missingTranscript,
      totalTargets: targets.length
    },
    tags
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output));
  console.log(`\nWrote ${OUTPUT_FILE}`);

  // Per-topic summary
  console.log(`\nPer-topic tag counts:`);
  const sorted = Object.entries(perTopicCount)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [id, count] of sorted) {
    const name = topics[id].name;
    console.log(`  ${count.toString().padStart(5)}  ${id.padEnd(28)} ${name}`);
  }
  const zeroTopics = Object.entries(perTopicCount).filter(([, c]) => c === 0);
  if (zeroTopics.length > 0) {
    console.log(`\nTopics with 0 tags (consider removing from taxonomy):`);
    for (const [id] of zeroTopics) {
      console.log(`  - ${id}`);
    }
  }
}

main();

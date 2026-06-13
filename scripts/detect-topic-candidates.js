#!/usr/bin/env node
/**
 * Detect topic candidates from recent video descriptions.
 *
 * Looks for terms that have spiked in recent uploads vs the longer
 * baseline. Clusters related terms by video co-occurrence. Outputs a
 * markdown report that a human reviews and decides whether to add to
 * the site's STORY_CONFIG.
 *
 * Why semi-automatic instead of fully automatic: the editorial framing
 * is the point. Fully-automatic topic naming produces awkward labels
 * ("video about Karmelo" → topic name "video"?) and surfaces boring
 * recurring boilerplate as "topics". A human review step is 30 seconds
 * per story but keeps the site's editorial voice consistent.
 *
 * Output: public/topic-candidates.md
 *
 * Tunables (constants below):
 *   - RECENT_WINDOW_DAYS: how recent counts as "now" (7d)
 *   - BASELINE_WINDOW_DAYS: how far back to compare against (60d total)
 *   - MIN_RECENT_VIDEOS: ignore terms appearing in fewer than N recent vids
 *   - MIN_SPIKE_RATIO: ignore terms that aren't elevated enough (3x)
 *   - MAX_CLUSTERS: cap report to top N stories so it stays readable
 */
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'public', 'data.json');
const DESCRIPTIONS_FILE = path.join(__dirname, '..', 'public', 'descriptions.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'public', 'topic-candidates.md');
// Machine-readable companion to topic-candidates.md. The site reads this
// to render live story trackers without manual edits to index.html.
// Only clusters with recent-window saturation above the display threshold
// make it into this file — i.e. the editorially actionable ones.
const TRACKERS_FILE = path.join(__dirname, '..', 'public', 'topic-trackers.json');

const RECENT_WINDOW_DAYS = 7;
const BASELINE_WINDOW_DAYS = 60;
const MIN_RECENT_VIDEOS = 3;
const MIN_SPIKE_RATIO = 3;
const MAX_CLUSTERS = 6;
const CLUSTER_OVERLAP_THRESHOLD = 0.35; // Jaccard similarity to merge terms
// Trackers only get exported if the cluster's 7-day saturation hits this.
// Matches the site's own display threshold so we don't export trackers
// that the site would immediately hide.
const TRACKER_EXPORT_THRESHOLD = 0.30;

// Conservative stopword list. The spike ratio already filters out common
// words (they'd appear equally in recent and baseline → ratio of 1). This
// list catches a few common short tokens that slip through and the most
// common channel-boilerplate terms.
const STOPWORDS = new Set([
  // articles, conjunctions, pronouns, common verbs
  'the', 'and', 'for', 'with', 'his', 'her', 'has', 'have', 'had', 'are', 'was',
  'were', 'been', 'being', 'this', 'that', 'these', 'those', 'they', 'them',
  'their', 'will', 'would', 'could', 'should', 'might', 'may', 'can', 'cant',
  'from', 'into', 'onto', 'over', 'under', 'about', 'above', 'after', 'before',
  'between', 'during', 'while', 'when', 'where', 'why', 'how', 'what', 'who',
  'whom', 'whose', 'which', 'than', 'then', 'thus', 'also', 'even', 'just',
  'only', 'some', 'such', 'each', 'every', 'either', 'both', 'one', 'two',
  'not', 'nor', 'but', 'yet', 'all', 'any', 'too', 'too', 'very',
  // verbs that don't carry topic info
  'said', 'says', 'gets', 'got', 'getting', 'goes', 'went', 'going', 'come',
  'comes', 'came', 'make', 'makes', 'made', 'making', 'take', 'takes', 'took',
  'taken', 'taking', 'give', 'gives', 'gave', 'given', 'giving',
  // youtube/channel boilerplate
  'video', 'videos', 'channel', 'subscribe', 'patreon', 'discord', 'twitter',
  'follow', 'link', 'links', 'description', 'comment', 'comments', 'like',
  'likes', 'today', 'tonight', 'yesterday', 'tomorrow', 'now', 'new', 'latest',
  'breaking', 'update', 'updates', 'news', 'report', 'reports', 'watch',
  'see', 'seen', 'show', 'shows', 'showing', 'live', 'stream', 'streaming',
  // overly generic
  'people', 'person', 'man', 'woman', 'men', 'women', 'kid', 'kids',
  'thing', 'things', 'something', 'anyone', 'everyone', 'nothing'
]);

function tokenize(text) {
  // Focus on the first ~300 chars — that's typically the topic-bearing
  // opener. Channel boilerplate (social links, sponsor codes) tends to
  // live in the back half of descriptions.
  const opener = text.slice(0, 300).toLowerCase();
  return opener
    .replace(/https?:\/\/\S+/g, ' ')           // strip URLs
    .replace(/[^a-z\s']/g, ' ')                // strip punctuation
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function generateNgrams(tokens, n) {
  const grams = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n).join(' ');
    grams.push(gram);
  }
  return grams;
}

function buildTermSet(description) {
  const tokens = tokenize(description);
  // Unigrams + bigrams. Trigrams would catch "Karmelo Anthony trial" but
  // also a lot of noise; bigrams alone catch the proper-noun pairs we want.
  return new Set([
    ...tokens,
    ...generateNgrams(tokens, 2)
  ]);
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function main() {
  if (!fs.existsSync(DATA_FILE) || !fs.existsSync(DESCRIPTIONS_FILE)) {
    console.error('Missing data.json or descriptions.json');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const descriptions = JSON.parse(fs.readFileSync(DESCRIPTIONS_FILE, 'utf8')).descriptions || {};

  const now = Date.now();
  const recentCutoff = now - RECENT_WINDOW_DAYS * 86400 * 1000;
  const baselineCutoff = now - BASELINE_WINDOW_DAYS * 86400 * 1000;

  // Build the per-channel video pools. Only long-form videos count —
  // shorts have minimal descriptions and would distort term frequencies.
  const channelPools = new Map();
  for (const v of data.videos) {
    if (v.isShort || v.unavailable) continue;
    const t = new Date(v.publishedAt).getTime();
    if (t < baselineCutoff) continue;
    const desc = descriptions[v.id];
    if (!desc) continue;

    if (!channelPools.has(v.channelId)) {
      channelPools.set(v.channelId, { recent: [], baseline: [] });
    }
    const pool = channelPools.get(v.channelId);
    const entry = {
      id: v.id,
      title: v.title,
      publishedAt: v.publishedAt,
      views: v.views || 0,
      likes: v.likes || 0,
      terms: buildTermSet(desc),
      descPreview: desc.split('\n')[0].slice(0, 120)
    };
    if (t >= recentCutoff) pool.recent.push(entry);
    else pool.baseline.push(entry);
  }

  const channelMeta = data.channels || {};
  let md = `# Topic candidates — ${new Date().toISOString().slice(0, 10)}\n\n`;
  md += `_Auto-generated nightly from video descriptions. Clusters of terms `;
  md += `that have spiked in recent uploads (last ${RECENT_WINDOW_DAYS} days) `;
  md += `relative to the ${BASELINE_WINDOW_DAYS - RECENT_WINDOW_DAYS}-day baseline. `;
  md += `Review and add to STORY_CONFIG if any deserve a tracker._\n\n`;
  md += `---\n\n`;

  // Trackers list — clusters that meet the export threshold get included
  // in topic-trackers.json for the site to pick up automatically. Format
  // is minimal: termId, keywords, channel handle. The site computes its
  // own saturation/stats at render time using fresh data, so the detector
  // doesn't need to pre-compute every window here.
  const trackers = [];
  const detectedAt = new Date().toISOString();

  // Detect per-channel — a topic spiking on TheQuartering isn't necessarily
  // the same as one spiking on JeremyHambly. Treat each independently and
  // report what was found per channel.
  let anyClustersFound = false;
  for (const [channelId, pool] of channelPools) {
    const channel = channelMeta[channelId];
    const handle = channel ? channel.handle : channelId;
    if (pool.recent.length < MIN_RECENT_VIDEOS) continue;

    const recentCounts = new Map();
    const baselineCounts = new Map();
    for (const v of pool.recent) {
      for (const term of v.terms) {
        recentCounts.set(term, (recentCounts.get(term) || 0) + 1);
      }
    }
    for (const v of pool.baseline) {
      for (const term of v.terms) {
        baselineCounts.set(term, (baselineCounts.get(term) || 0) + 1);
      }
    }

    const candidates = [];
    for (const [term, recentCount] of recentCounts) {
      if (recentCount < MIN_RECENT_VIDEOS) continue;
      const baselineCount = baselineCounts.get(term) || 0;
      const recentFreq = recentCount / pool.recent.length;
      // Smoothing avoids div-by-zero and requires a meaningful baseline
      // presence for "spike" to be meaningful (otherwise a term that
      // appears 3 times recently and never before would be infinite-ratio).
      const baselineFreq = (baselineCount + 0.5) / (pool.baseline.length + 1);
      const ratio = recentFreq / baselineFreq;
      if (ratio < MIN_SPIKE_RATIO) continue;
      candidates.push({
        term, recentCount, baselineCount, ratio,
        // Pre-compute the recent video set for clustering
        videoIds: new Set(pool.recent.filter(v => v.terms.has(term)).map(v => v.id))
      });
    }
    candidates.sort((a, b) => b.ratio - a.ratio);

    // Greedy clustering: take the highest-spike term, find other candidate
    // terms that mostly cover the same recent videos (Jaccard similarity
    // above threshold), group them, remove from consideration, repeat.
    const clusters = [];
    const used = new Set();
    for (const candidate of candidates) {
      if (used.has(candidate.term)) continue;
      const groupTerms = [candidate.term];
      const groupVideos = new Set(candidate.videoIds);
      used.add(candidate.term);
      for (const other of candidates) {
        if (used.has(other.term)) continue;
        const sim = jaccardSimilarity(candidate.videoIds, other.videoIds);
        if (sim >= CLUSTER_OVERLAP_THRESHOLD) {
          groupTerms.push(other.term);
          for (const id of other.videoIds) groupVideos.add(id);
          used.add(other.term);
        }
      }
      // Find baseline videos matching this cluster for comparison
      const baselineMatching = pool.baseline.filter(v =>
        groupTerms.some(t => v.terms.has(t))
      );
      const recentMatching = pool.recent.filter(v => groupVideos.has(v.id));
      // Re-label the cluster using the term with the highest recent count
      // within the cluster — that's the term most representative of what
      // the cluster actually contains. The seed term has the highest spike
      // ratio but that's often a sponsorship/boilerplate term that's
      // recently grown (e.g. "coffee" if the channel just took on a new
      // coffee sponsor) and isn't editorial topic content.
      const labelTerm = [...groupTerms].sort((a, b) =>
        (recentCounts.get(b) || 0) - (recentCounts.get(a) || 0)
      )[0];
      // Cluster-level spike ratio computed on the union of all cluster terms
      // (any-match), which is a more honest measure than the seed term alone.
      const clusterRecentFreq = recentMatching.length / pool.recent.length;
      const clusterBaselineFreq = (baselineMatching.length + 0.5) / (pool.baseline.length + 1);
      const clusterRatio = clusterRecentFreq / clusterBaselineFreq;
      clusters.push({
        topTerm: labelTerm,
        ratio: clusterRatio,
        // Cap shown terms — beyond ~8 it gets noisy. Single tokens first
        // (they tend to be the strongest signal), then bigrams.
        terms: [...groupTerms].sort((a, b) => {
          const wordsA = a.split(' ').length;
          const wordsB = b.split(' ').length;
          if (wordsA !== wordsB) return wordsA - wordsB;
          return (recentCounts.get(b) || 0) - (recentCounts.get(a) || 0);
        }).slice(0, 8),
        recentCount: recentMatching.length,
        recentTotal: pool.recent.length,
        baselineCount: baselineMatching.length,
        baselineTotal: pool.baseline.length,
        sampleVideos: recentMatching
          .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
          .slice(0, 5)
      });

      // Tracker export: include this cluster if it's hot enough.
      // 7-day saturation (cluster_recent_freq) crosses the threshold →
      // export. Keywords are a generous superset of cluster terms so the
      // site can match flexibly; the site does its own keyword matching
      // against descriptions when rendering.
      if (clusterRecentFreq >= TRACKER_EXPORT_THRESHOLD) {
        trackers.push({
          channelHandle: handle,
          termId: labelTerm,
          // Keep more keywords here than in the markdown report — the
          // site uses these for description matching and the more we
          // include the better the match rate. Capped at 12 to avoid
          // pathological cases.
          keywords: [...groupTerms].slice(0, 12),
          detectorMeta: {
            recentSaturation: Number(clusterRecentFreq.toFixed(4)),
            baselineSaturation: Number(clusterBaselineFreq.toFixed(4)),
            spikeRatio: Number(clusterRatio.toFixed(2)),
            recentVideoCount: recentMatching.length,
            baselineVideoCount: baselineMatching.length,
            detectedAt
          }
        });
      }
      if (clusters.length >= MAX_CLUSTERS) break;
    }

    if (clusters.length === 0) continue;
    anyClustersFound = true;

    md += `## ${handle}\n\n`;
    md += `Pool: ${pool.recent.length} recent videos, ${pool.baseline.length} baseline videos\n\n`;

    clusters.forEach((c, i) => {
      const recentPct = (c.recentCount / c.recentTotal * 100).toFixed(0);
      const baselinePct = c.baselineTotal > 0
        ? (c.baselineCount / c.baselineTotal * 100).toFixed(0)
        : '0';
      md += `### Cluster ${i + 1}: \`${c.topTerm}\`\n\n`;
      md += `- **Recent saturation:** ${c.recentCount}/${c.recentTotal} videos (**${recentPct}%**)\n`;
      md += `- **Baseline saturation:** ${c.baselineCount}/${c.baselineTotal} videos (${baselinePct}%)\n`;
      md += `- **Spike ratio:** ${c.ratio.toFixed(1)}x\n`;
      md += `- **Related terms:** \`${c.terms.join('\`, \`')}\`\n`;
      md += `- **Sample recent videos:**\n`;
      for (const v of c.sampleVideos) {
        md += `  - ${v.publishedAt.slice(0, 10)} — _${v.title}_  \n`;
        md += `    ${v.descPreview}\n`;
      }
      md += `\n`;
    });
  }

  if (!anyClustersFound) {
    md += `_No topic clusters above the spike threshold this run._\n\n`;
  }

  md += `---\n\n`;
  md += `_Tunables: recent=${RECENT_WINDOW_DAYS}d, baseline=${BASELINE_WINDOW_DAYS}d, `;
  md += `min recent videos=${MIN_RECENT_VIDEOS}, min spike ratio=${MIN_SPIKE_RATIO}x_  \n`;
  md += `_Generated by scripts/detect-topic-candidates.js_\n`;

  fs.writeFileSync(OUTPUT_FILE, md);
  console.log(`Wrote ${OUTPUT_FILE}`);

  // Write the machine-readable trackers companion. The site loads this
  // and renders any trackers it finds — no code changes needed when a
  // new topic spikes.
  const trackersOut = {
    lastUpdated: detectedAt,
    trackers
  };
  fs.writeFileSync(TRACKERS_FILE, JSON.stringify(trackersOut, null, 2));
  console.log(`Wrote ${TRACKERS_FILE} with ${trackers.length} tracker(s)`);
}

main();

// Re-audit the transcript-mix classification against the Anthropic API directly
// (Brad's own ANTHROPIC_API_KEY, same billing path as the topic tagger — NOT
// Claude Code subagents).
//
// Three things this fixes versus the published numbers:
//   1. Only 48 of 333 blocks were ever double-rated. This rates all 333, twice.
//   2. The original blind audit saw each block with NO surrounding context, which
//      systematically pushed it toward "substance". Here each rater sees the
//      neighbouring blocks, so "he is still reading the article" is visible.
//   3. A block got ONE label even when it was half quote and half his own point.
//      Raters now return a proportional split, which is what "share of runtime"
//      actually claims.
//
// Two DIFFERENT models rate independently (decorrelated errors — two runs of the
// same model agreeing proves much less), then a third pass adjudicates only the
// blocks where they materially disagree.
//
// Usage: node reaudit.js [--limit N] [--smoke] [--stage rate|adjudicate|all]
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const TASK = path.join(HERE, '..', 'tasks', 'w5imlqk29.output');
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_HEADERS = k => ({ 'content-type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' });

const RATERS = [
  { id: 'A', model: 'claude-opus-5' },
  { id: 'B', model: 'claude-sonnet-5' },
];
const ADJUDICATOR = 'claude-opus-5';
// $ per million tokens, input/output.
const PRICE = {
  'claude-opus-5': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-haiku-4-5-20251001': [1, 5],
};

const RUBRIC = `You are analysing auto-generated transcripts of long-form YouTube commentary videos by a single presenter. The transcripts are machine-produced: punctuation is unreliable, speaker labels are mostly absent, and there are NO quotation marks. You must infer from wording, register and structure when he is reciting someone else's words rather than speaking his own.

For each numbered block (~30 seconds of runtime) estimate how the block's SPOKEN TIME divides across exactly four categories. Give proportions in 0.1 increments that sum to 1.0.

S = OWN SUBSTANCE
His own claim, argument, analysis, prediction, first-hand anecdote or evidence. Still counts when it is about the source material, and when he supplies background context in his own words. A genuine point counts even if briefly made.

Q = READ ALOUD / SOURCE MATERIAL
Words originating outside him: reciting an article, headline, tweet, post, filing, chat message or comment; audio from a clip he is playing (often signalled by ">>" markers, an abrupt change of register, or interview-style back-and-forth); close paraphrase of a source he is visibly reading from. Short interjections inside a long recitation ("Wow." / "Don't care.") remain Q unless they carry a real point of their own.

F = FILLER
Adds no new information. Restating a point already made in the same video; meandering set-up; stalling while something loads; verbal throat-clearing; repeated catchphrases; banter carrying no information; narrating what is already on screen; trailing self-repetition ("It's insane. It's insane."); rhetorical padding ("you know what I mean", "but they never do, do they").

P = PROMOTION
Sponsor reads, merchandise, memberships, Patreon, like-and-subscribe requests, plugs for his other channels or streams.

RULES
- Proportions are of spoken time, not sentence count.
- Most blocks are mixed. Do not force a single category unless the block genuinely is one.
- When genuinely torn between two categories for the same span, choose in this order of preference: S, then Q, then P, then F. This deliberately makes the filler figure a floor rather than a ceiling.
- Score ONLY the blocks under "SCORE THESE". Context blocks are there to tell you what is going on and must not be scored.
- No preamble, no summary, no reasoning beyond the short note.

OUTPUT — one line per scored block and nothing else:
<n> | S0.0 Q0.0 F0.0 P0.0 | <note, 10 words max>`;

// ---------------------------------------------------------------- helpers ---
async function callAPI(system, userMsg, model, apiKey, maxTokens) {
  // No `temperature`: the 5-series models reject it outright.
  const body = {
    model, max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMsg }],
  };
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(API_URL, { method: 'POST', headers: API_HEADERS(apiKey), body: JSON.stringify(body) });
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        const w = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
        console.warn(`  API ${res.status}; retry ${attempt}/5 in ${Math.round(w)}ms`);
        await new Promise(r => setTimeout(r, w)); continue;
      }
      // Any other 4xx is a bad request — retrying just burns the same error five times.
      if (!res.ok) throw Object.assign(new Error(`API ${res.status}: ${(await res.text()).slice(0, 300)}`), { fatal: true });
      const data = await res.json();
      const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      return { text, usage: data.usage || null, truncated: data.stop_reason === 'max_tokens' };
    } catch (e) {
      lastErr = e;
      if (e.fatal) throw e;
      const w = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
      console.warn(`  API error (${e.message}); retry ${attempt}/5 in ${Math.round(w)}ms`);
      await new Promise(r => setTimeout(r, w));
    }
  }
  throw lastErr || new Error('API failed');
}

async function runPool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// "12 | S0.6 Q0.4 F0.0 P0.0 | reads article" -> {12: {S:.6,Q:.4,F:0,P:0,note}}
//
// Deliberately tolerant. Models routinely drop the zero categories and write
// "[1] | S0.8 F0.2 | note", and they vary the order. An earlier strict version of
// this demanded all four in S/Q/F/P order and silently discarded ~40% of the
// responses — and not at random, since blocks that were purely one thing were
// exactly the ones written with categories missing. Parse whatever is present,
// treat absent categories as zero.
function parseScores(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length < 2) continue;
    // The block number, optionally followed by the timestamp echoed back from the
    // prompt ("[7] 03:11 | ..."), which is how the rest of the lost responses died.
    const nm = /^\s*\[?(\d+)\]?\s*(?:\d{1,2}:\d{2}(?::\d{2})?)?\s*$/.exec(parts[0]);
    if (!nm) continue;
    // Only the scores segment is scanned, so a note mentioning "P2" can't leak in.
    const pairs = [...parts[1].matchAll(/([SQFP])\s*[:=]?\s*([01]?\.?\d+)/g)];
    if (!pairs.length) continue;
    const v = { S: 0, Q: 0, F: 0, P: 0, note: parts.slice(2).join('|').trim() };
    for (const p of pairs) v[p[1]] = +p[2];
    const sum = v.S + v.Q + v.F + v.P;
    if (!(sum > 0)) continue;
    if (Math.abs(sum - 1) > 0.001) for (const k of ['S', 'Q', 'F', 'P']) v[k] = v[k] / sum; // normalise sloppy sums
    out.set(+nm[1], v);
  }
  return out;
}

const dom = v => ['S', 'Q', 'F', 'P'].reduce((a, k) => (v[k] > v[a] ? k : a), 'S');
const maxDelta = (a, b) => Math.max(...['S', 'Q', 'F', 'P'].map(k => Math.abs(a[k] - b[k])));

// ------------------------------------------------------------------ input ---
function loadCorpus() {
  const top = JSON.parse(fs.readFileSync(TASK, 'utf8'));
  const idx = JSON.parse(fs.readFileSync(path.join(HERE, 'tr-index.json'), 'utf8'));
  const meta = {}; idx.forEach(v => meta[v.id] = v);
  const videos = [];
  for (const r of top.result.classified) {
    const raw = fs.readFileSync(path.join(HERE, 'tr-' + r.id + '.txt'), 'utf8').split('\n\n');
    const blocks = raw.slice(1).map((b, i) => {
      const m = /^\[(\d+)\]\s*(\S+)\s*([\s\S]*)$/.exec(b.trim());
      return m ? { n: +m[1], t: m[2], text: m[3].replace(/\s+/g, ' ').trim() } : { n: i + 1, t: '', text: b.trim() };
    }).filter(b => b.text);
    const orig = new Map(r.blocks.map(b => [b.n, b.cat]));
    videos.push({ id: r.id, title: (meta[r.id] || {}).title || r.id, dur: (meta[r.id] || {}).dur || 0, blocks, orig });
  }
  return videos;
}

// ------------------------------------------------------------------- rate ---
const BATCH = 12;
function buildBatches(videos) {
  const out = [];
  for (const v of videos) {
    for (let i = 0; i < v.blocks.length; i += BATCH) {
      out.push({ vid: v.id, title: v.title, dur: v.dur, blocks: v.blocks.slice(i, i + BATCH), before: v.blocks[i - 1] || null, after: v.blocks[i + BATCH] || null });
    }
  }
  return out;
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
function batchMsg(b) {
  const parts = [`VIDEO: ${b.title} (${Math.round(b.dur / 60)} minutes)`, ''];
  if (b.before) parts.push('--- CONTEXT, the block immediately before (do NOT score) ---', clip(b.before.text, 400), '');
  parts.push('--- SCORE THESE ---');
  for (const bl of b.blocks) parts.push(`[${bl.n}] ${bl.t}  ${bl.text}`, '');
  if (b.after) parts.push('--- CONTEXT, the block immediately after (do NOT score) ---', clip(b.after.text, 400));
  return parts.join('\n');
}

// Exported so probes can reuse the corpus/prompt builders. Guarding main behind
// require.main matters: without it, `require('./reaudit.js')` silently starts a
// full paid run.
module.exports = { loadCorpus, buildBatches, batchMsg, parseScores, callAPI, RUBRIC, RATERS };

async function main() {
  const args = process.argv.slice(2);
  const has = f => args.includes(f);
  const num = (f, d) => { const i = args.indexOf(f); return i >= 0 ? +args[i + 1] : d; };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

  const videos = loadCorpus();
  let batches = buildBatches(videos);
  if (has('--smoke')) batches = batches.slice(0, 1);
  else if (num('--limit', 0)) batches = batches.slice(0, num('--limit', 0));
  const nBlocks = batches.reduce((s, b) => s + b.blocks.length, 0);
  console.log(`corpus: ${videos.length} videos, ${videos.reduce((s, v) => s + v.blocks.length, 0)} blocks`);
  console.log(`this run: ${batches.length} batches / ${nBlocks} blocks × ${RATERS.length} raters\n`);

  const cost = {}, rawLog = [];
  const bill = (model, u) => {
    if (!u) return;
    const c = cost[model] || (cost[model] = { in: 0, out: 0, cache: 0 });
    c.in += u.input_tokens || 0; c.out += u.output_tokens || 0;
    c.cache += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  };

  // ---- stage 1: two independent raters over every block --------------------
  const scores = {};   // raterId -> Map("vid#n" -> {S,Q,F,P,note})
  for (const r of RATERS) {
    console.log(`rater ${r.id} (${r.model}) …`);
    // 4000, not 1600: these models spend output tokens on thinking before the
    // answer, and a 12-block batch was hitting the cap mid-list — which silently
    // dropped the tail of the batch rather than erroring.
    const maps = await runPool(batches, 4, async (b) => {
      const want = b.blocks.map(x => x.n);
      const res = await callAPI(RUBRIC, batchMsg(b), r.model, apiKey, 4000);
      bill(r.model, res.usage);
      // Keep every raw response: a parser bug should cost a re-parse, not a re-run.
      rawLog.push({ rater: r.id, vid: b.vid, from: want[0], to: want[want.length - 1], truncated: res.truncated, text: res.text });
      let parsed = parseScores(res.text);
      // Repair pass: re-ask for whatever did not come back, alone.
      const missing = want.filter(n => !parsed.has(n));
      if (missing.length) {
        const only = { ...b, blocks: b.blocks.filter(x => missing.includes(x.n)) };
        const res2 = await callAPI(RUBRIC, batchMsg(only), r.model, apiKey, 4000);
        bill(r.model, res2.usage);
        rawLog.push({ rater: r.id, vid: b.vid, repair: true, want: missing, truncated: res2.truncated, text: res2.text });
        for (const [n, v] of parseScores(res2.text)) if (missing.includes(n)) parsed.set(n, v);
      }
      return { vid: b.vid, parsed, want };
    });
    const m = new Map(); let missing = 0;
    for (const s of maps) for (const n of s.want) {
      const v = s.parsed.get(n);
      if (v) m.set(s.vid + '#' + n, v); else missing++;
    }
    scores[r.id] = m;
    console.log(`  scored ${m.size} blocks${missing ? `, ${missing} unparsed` : ''}`);
  }

  fs.writeFileSync(path.join(HERE, 'reaudit-raw.json'), JSON.stringify({
    A: Object.fromEntries(scores.A), B: Object.fromEntries(scores.B),
  }));
  fs.writeFileSync(path.join(HERE, 'reaudit-responses.json'), JSON.stringify(rawLog));

  // Coverage gate. Partial coverage is not a partial answer here — responses are
  // lost in whole batches, so the survivors are a biased subset, not a sample.
  const expected = nBlocks;
  for (const r of RATERS) {
    const got = scores[r.id].size, pct = got / expected * 100;
    if (pct < 97) {
      console.error(`
ABORT: rater ${r.id} covered only ${got}/${expected} blocks (${pct.toFixed(0)}%).`);
      console.error('Raw responses saved to reaudit-responses.json — re-parse those rather than re-running.');
      process.exit(1);
    }
  }

  // ---- stage 2: adjudicate material disagreements --------------------------
  const disputes = [];
  for (const [key, a] of scores.A) {
    const b = scores.B.get(key); if (!b) continue;
    if (dom(a) !== dom(b) || maxDelta(a, b) >= 0.3) disputes.push({ key, a, b });
  }
  const both = [...scores.A.keys()].filter(k => scores.B.has(k));
  console.log(`\nrater agreement: ${both.length - disputes.length}/${both.length} = ` +
    `${((both.length - disputes.length) / both.length * 100).toFixed(0)}% (dominant category + no component off by >=0.3)`);
  console.log(`disputes to adjudicate: ${disputes.length}`);

  const byVid = {};
  for (const d of disputes) { const [vid, n] = d.key.split('#'); (byVid[vid] || (byVid[vid] = [])).push({ ...d, n: +n }); }
  const adjJobs = Object.entries(byVid).flatMap(([vid, list]) => {
    const v = videos.find(x => x.id === vid);
    const out = [];
    for (let i = 0; i < list.length; i += 8) out.push({ v, list: list.slice(i, i + 8) });
    return out;
  });

  const ADJ_RUBRIC = RUBRIC + `

You are now ADJUDICATING. Two independent raters scored these blocks and disagreed. Both proposals are shown. They are suggestions only — you have wider context than either had, and you should give the correct split even when it matches neither. Apply the same rules, especially the tie-break preference S > Q > P > F.`;

  const adj = new Map();
  if (adjJobs.length) {
    console.log(`\nadjudicator (${ADJUDICATOR}) — ${adjJobs.length} calls …`);
    const res = await runPool(adjJobs, 4, async (job) => {
      const { v, list } = job;
      const lines = [`VIDEO: ${v.title} (${Math.round(v.dur / 60)} minutes)`, ''];
      const ctx = new Set();
      for (const d of list) for (let k = d.n - 2; k <= d.n + 2; k++) ctx.add(k);
      lines.push('--- TRANSCRIPT, wider context (score only the blocks listed at the end) ---');
      for (const bl of v.blocks) if (ctx.has(bl.n)) lines.push(`[${bl.n}] ${bl.t}  ${clip(bl.text, 700)}`, '');
      lines.push('--- SCORE THESE, with the two raters\' disagreeing proposals ---');
      for (const d of list) {
        const f = x => `S${x.S.toFixed(1)} Q${x.Q.toFixed(1)} F${x.F.toFixed(1)} P${x.P.toFixed(1)}`;
        lines.push(`[${d.n}]  rater 1: ${f(d.a)}${d.a.note ? ` (${d.a.note})` : ''}   rater 2: ${f(d.b)}${d.b.note ? ` (${d.b.note})` : ''}`);
      }
      const r = await callAPI(ADJ_RUBRIC, lines.join('\n'), ADJUDICATOR, apiKey, 4000);
      bill(ADJUDICATOR, r.usage);
      return { vid: v.id, parsed: parseScores(r.text) };
    });
    for (const r of res) for (const [n, v] of r.parsed) adj.set(r.vid + '#' + n, v);
    console.log(`  adjudicated ${adj.size} blocks`);
  }

  // ---- stage 3: reconcile --------------------------------------------------
  const final = new Map();
  for (const key of both) {
    const a = scores.A.get(key), b = scores.B.get(key), j = adj.get(key);
    if (j) { final.set(key, { ...j, src: 'adjudicated' }); continue; }
    final.set(key, { S: (a.S + b.S) / 2, Q: (a.Q + b.Q) / 2, F: (a.F + b.F) / 2, P: (a.P + b.P) / 2, src: 'agreed' });
  }
  for (const key of scores.A.keys()) if (!final.has(key)) final.set(key, { ...scores.A.get(key), src: 'A-only' });

  fs.writeFileSync(path.join(HERE, 'reaudit-final.json'), JSON.stringify({
    generated: null, raters: RATERS, adjudicator: ADJUDICATOR,
    agreement: (both.length - disputes.length) / both.length,
    blocksRated: both.length, disputes: disputes.length,
    scores: Object.fromEntries(final),
  }));

  // ---- report --------------------------------------------------------------
  const tot = { S: 0, Q: 0, F: 0, P: 0 }; let n = 0;
  for (const v of final.values()) { for (const k of ['S', 'Q', 'F', 'P']) tot[k] += v[k]; n++; }
  const oldTot = { S: 0, Q: 0, F: 0, P: 0 }; let oldN = 0;
  for (const v of videos) for (const [, c] of v.orig) { if (oldTot[c] !== undefined) { oldTot[c]++; oldN++; } }

  console.log('\n=== OVERALL ===');
  console.log('              published   re-audit    delta');
  for (const k of ['S', 'Q', 'F', 'P']) {
    const o = oldTot[k] / oldN * 100, w = tot[k] / n * 100;
    console.log('  ' + { S: 'substance', Q: 'read aloud', F: 'filler', P: 'promo' }[k].padEnd(12) +
      (o.toFixed(1) + '%').padStart(8) + (w.toFixed(1) + '%').padStart(11) +
      ((w - o >= 0 ? '+' : '') + (w - o).toFixed(1)).padStart(9));
  }

  let $ = 0;
  console.log('\n=== COST ===');
  for (const [m, c] of Object.entries(cost)) {
    const p = PRICE[m] || [0, 0];
    const d = (c.in + c.cache) / 1e6 * p[0] + c.out / 1e6 * p[1];
    $ += d;
    console.log(`  ${m.padEnd(20)} in ${c.in + c.cache} out ${c.out}  $${d.toFixed(3)}`);
  }
  console.log(`  TOTAL $${$.toFixed(2)}`);
}

if (require.main === module) main();

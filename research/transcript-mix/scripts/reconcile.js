// Resume the re-audit from the saved raw responses: top up the handful of blocks
// one rater never emitted, measure agreement over all 333, adjudicate the material
// disagreements, and write reaudit-final.json.
//
// Deliberately does NOT re-run the raters — their responses are already on disk in
// reaudit-responses.json, which is the whole reason that file exists.
const fs = require('fs');
const path = require('path');
const R = require('./reaudit.js');
const HERE = __dirname;
const CATS = ['S', 'Q', 'F', 'P'];
const ADJUDICATOR = 'claude-opus-5';
const PRICE = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [3, 15] };

const dom = v => CATS.reduce((a, k) => (v[k] > v[a] ? k : a), 'S');
const maxDelta = (a, b) => Math.max(...CATS.map(k => Math.abs(a[k] - b[k])));
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

(async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }

  const videos = R.loadCorpus();
  const byId = Object.fromEntries(videos.map(v => [v.id, v]));
  const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'reaudit-responses.json'), 'utf8'));

  const scores = { A: new Map(), B: new Map() };
  for (const r of raw) for (const [n, v] of R.parseScores(r.text)) scores[r.rater].set(r.vid + '#' + n, v);
  console.log(`re-parsed saved responses: A ${scores.A.size}/333, B ${scores.B.size}/333`);

  const cost = {};
  const bill = (m, u) => {
    if (!u) return; const c = cost[m] || (cost[m] = { in: 0, out: 0 });
    c.in += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    c.out += u.output_tokens || 0;
  };

  // ---- top up blocks a rater never emitted --------------------------------
  const MODEL = { A: 'claude-opus-5', B: 'claude-sonnet-5' };
  for (const rid of ['A', 'B']) {
    const missing = [];
    for (const v of videos) for (const b of v.blocks) if (!scores[rid].has(v.id + '#' + b.n)) missing.push({ vid: v.id, n: b.n });
    if (!missing.length) continue;
    console.log(`\ntopping up rater ${rid}: ${missing.length} blocks`);
    const byVid = {};
    for (const m of missing) (byVid[m.vid] || (byVid[m.vid] = [])).push(m.n);
    for (const [vid, ns] of Object.entries(byVid)) {
      const v = byId[vid];
      const b = {
        vid, title: v.title, dur: v.dur,
        blocks: v.blocks.filter(x => ns.includes(x.n)),
        before: v.blocks.find(x => x.n === Math.min(...ns) - 1) || null,
        after: v.blocks.find(x => x.n === Math.max(...ns) + 1) || null,
      };
      const res = await R.callAPI(R.RUBRIC, R.batchMsg(b), MODEL[rid], apiKey, 4000);
      bill(MODEL[rid], res.usage);
      let n = 0;
      for (const [k, val] of R.parseScores(res.text)) if (ns.includes(k)) { scores[rid].set(vid + '#' + k, val); n++; }
      console.log(`  ${vid}: asked ${ns.length}, got ${n}`);
    }
  }
  for (const rid of ['A', 'B']) {
    const pct = scores[rid].size / 333 * 100;
    console.log(`rater ${rid} coverage: ${scores[rid].size}/333 (${pct.toFixed(0)}%)`);
    if (pct < 97) { console.error('ABORT: coverage still short'); process.exit(1); }
  }

  // ---- agreement + adjudication ------------------------------------------
  const both = [...scores.A.keys()].filter(k => scores.B.has(k));
  const disputes = [];
  for (const key of both) {
    const a = scores.A.get(key), b = scores.B.get(key);
    if (dom(a) !== dom(b) || maxDelta(a, b) >= 0.3) disputes.push({ key, a, b });
  }
  const agreement = (both.length - disputes.length) / both.length;
  console.log(`\nagreement over ${both.length} blocks: ${(agreement * 100).toFixed(0)}% ` +
    `(same dominant category and no component off by >=0.3)`);
  // A softer measure too — mean absolute difference per category is a fairer read
  // of two raters who mostly differ by a tenth here or there.
  let mad = 0;
  for (const key of both) { const a = scores.A.get(key), b = scores.B.get(key); mad += CATS.reduce((s, k) => s + Math.abs(a[k] - b[k]), 0) / 4; }
  console.log(`mean absolute difference per category: ${(mad / both.length * 100).toFixed(1)} percentage points`);
  console.log(`disputes to adjudicate: ${disputes.length}`);

  const byVid = {};
  for (const d of disputes) { const [vid, n] = d.key.split('#'); (byVid[vid] || (byVid[vid] = [])).push({ ...d, n: +n }); }
  const jobs = Object.entries(byVid).flatMap(([vid, list]) => {
    const out = []; for (let i = 0; i < list.length; i += 8) out.push({ v: byId[vid], list: list.slice(i, i + 8) });
    return out;
  });

  const ADJ = R.RUBRIC + `

You are now ADJUDICATING. Two independent raters scored these blocks and disagreed. Both proposals are shown. They are suggestions only — you have a wider window of transcript than either rater had, and you should give the correct split even when it matches neither. Apply the same rules, especially the tie-break preference S > Q > P > F.`;

  const adj = new Map();
  if (jobs.length) {
    console.log(`\nadjudicating (${ADJUDICATOR}) — ${jobs.length} calls …`);
    let done = 0;
    const results = await (async () => {
      const out = []; let i = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < jobs.length) {
          const job = jobs[i++];
          const { v, list } = job;
          const ctx = new Set();
          for (const d of list) for (let k = d.n - 2; k <= d.n + 2; k++) ctx.add(k);
          const lines = [`VIDEO: ${v.title} (${Math.round(v.dur / 60)} minutes)`, '',
            '--- TRANSCRIPT, wider context (score ONLY the blocks listed at the end) ---'];
          for (const bl of v.blocks) if (ctx.has(bl.n)) lines.push(`[${bl.n}] ${bl.t}  ${clip(bl.text, 700)}`, '');
          lines.push("--- SCORE THESE, with the two raters' disagreeing proposals ---");
          for (const d of list) {
            const f = x => CATS.map(k => k + x[k].toFixed(1)).join(' ');
            lines.push(`[${d.n}]  rater 1: ${f(d.a)}${d.a.note ? ` (${d.a.note})` : ''}   rater 2: ${f(d.b)}${d.b.note ? ` (${d.b.note})` : ''}`);
          }
          const r = await R.callAPI(ADJ, lines.join('\n'), ADJUDICATOR, apiKey, 4000);
          bill(ADJUDICATOR, r.usage);
          out.push({ vid: v.id, parsed: R.parseScores(r.text), want: list.map(d => d.n) });
          if (++done % 4 === 0) console.log(`  ${done}/${jobs.length}`);
        }
      }));
      return out;
    })();
    for (const r of results) for (const [n, v] of r.parsed) if (r.want.includes(n)) adj.set(r.vid + '#' + n, v);
    console.log(`  adjudicated ${adj.size}/${disputes.length}`);
  }

  // ---- reconcile ----------------------------------------------------------
  const final = new Map();
  for (const key of both) {
    const a = scores.A.get(key), b = scores.B.get(key), j = adj.get(key);
    if (j) final.set(key, { S: j.S, Q: j.Q, F: j.F, P: j.P, src: 'adjudicated' });
    else final.set(key, Object.fromEntries([...CATS.map(k => [k, (a[k] + b[k]) / 2]), ['src', 'agreed']]));
  }
  // A block only one rater scored still beats dropping it.
  for (const rid of ['A', 'B']) for (const [key, v] of scores[rid]) if (!final.has(key)) final.set(key, { ...v, src: rid + '-only' });

  fs.writeFileSync(path.join(HERE, 'reaudit-final.json'), JSON.stringify({
    raters: [{ id: 'A', model: 'claude-opus-5' }, { id: 'B', model: 'claude-sonnet-5' }],
    adjudicator: ADJUDICATOR, agreement, madPct: mad / both.length * 100,
    blocksRated: both.length, disputes: disputes.length, scores: Object.fromEntries(final),
  }));
  console.log(`\nwrote reaudit-final.json — ${final.size} blocks ` +
    `(${[...final.values()].filter(v => v.src === 'adjudicated').length} adjudicated)`);

  let $ = 0;
  for (const [m, c] of Object.entries(cost)) {
    const p = PRICE[m] || [0, 0]; const d = c.in / 1e6 * p[0] + c.out / 1e6 * p[1]; $ += d;
    console.log(`  ${m}  in ${c.in} out ${c.out}  $${d.toFixed(3)}`);
  }
  console.log(`  this stage cost $${$.toFixed(2)}`);
})();

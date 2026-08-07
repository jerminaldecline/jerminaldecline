// Deterministic filler tally straight from the transcripts. No model, no API, no
// judgement — just counting. Every number here is reproducible by anyone with the
// same files.
//
// Three tiers, kept separate because they are NOT equally solid:
//   1 HARD   uh / um / erm ...      unambiguous disfluency. Nothing else it can be.
//   2 STUTTER immediate word repeats ("if if you", "it's it's") — a real speech
//            artefact, but some doubles are legitimate English ("very very"),
//            so a small allowlist is excluded and both figures are reported.
//   3 HEDGE  "you know", "I mean", "like", "basically" ... genuinely ambiguous:
//            "like" is often a preposition. Reported, never merged into the total.
//
// Usage: node filler-scan.js [--channel <id>] [--min-seconds 300] [--json out.json]
const fs = require('fs');
const path = require('path');
const TR = 'C:/tmp/transcripts-repo/transcripts';

const HARD = new Set(['uh', 'um', 'umm', 'uhh', 'uhm', 'erm', 'mm', 'mhm', 'hmm', 'uhhh', 'ummm']);
// Doubling these is normal English, not a stumble.
const OK_DOUBLE = new Set(['very', 'really', 'so', 'no', 'yes', 'ha', 'that', 'had', 'is',
  'good', 'bye', 'well', 'long', 'far', 'more', 'again', 'now', 'come', 'go', 'run', 'blah']);
const HEDGE_UNI = ['like', 'basically', 'literally', 'actually', 'obviously', 'honestly', 'anyway', 'whatever'];
const HEDGE_BI = [['you', 'know'], ['i', 'mean'], ['sort', 'of'], ['kind', 'of'], ['or', 'whatever'], ['right', 'so']];

function tokenise(s) {
  return s.toLowerCase().replace(/\[[^\]]*\]/g, ' ')      // [music], [laughter], [ __ ]
    .replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
}

function analyse(t) {
  const segs = t.segments || [];
  if (!segs.length) return null;
  const toks = tokenise(segs.map(s => s.text).join(' '));
  if (toks.length < 50) return null;
  const lastMs = segs[segs.length - 1].offset + (segs[segs.length - 1].duration || 0);
  const dur = lastMs / 1000;

  let hard = 0; const hardBreak = {};
  for (const w of toks) if (HARD.has(w)) { hard++; hardBreak[w] = (hardBreak[w] || 0) + 1; }

  let repAll = 0, repFiltered = 0;
  for (let i = 1; i < toks.length; i++) {
    if (toks[i] !== toks[i - 1]) continue;
    repAll++;
    if (!OK_DOUBLE.has(toks[i])) repFiltered++;
  }

  let hedge = 0; const hedgeBreak = {};
  for (const w of HEDGE_UNI) { const n = toks.filter(x => x === w).length; if (n) { hedge += n; hedgeBreak[w] = n; } }
  for (const [a, b] of HEDGE_BI) {
    let n = 0;
    for (let i = 1; i < toks.length; i++) if (toks[i - 1] === a && toks[i] === b) n++;
    if (n) { hedge += n; hedgeBreak[a + ' ' + b] = n; }
  }
  // "you know" already counted the words; nothing double-counts because unigram
  // hedges and bigram hedges share no members.

  return {
    id: t.videoId, channelId: t.channelId, title: t.title || '', publishedAt: t.publishedAt || null,
    durationSec: Math.round(dur), words: toks.length,
    wpm: +(toks.length / (dur / 60)).toFixed(1),
    hard, hardPer100: +(hard / toks.length * 100).toFixed(2), hardBreak,
    repAll, rep: repFiltered, repPer100: +(repFiltered / toks.length * 100).toFixed(2),
    hedge, hedgePer100: +(hedge / toks.length * 100).toFixed(2), hedgeBreak,
    // Words are roughly isochronous over a whole video, so share-of-words is a
    // fair proxy for share-of-time. Stated as an estimate, not a measurement.
    hardSec: +((hard / toks.length) * dur).toFixed(1),
  };
}

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const MIN = +arg('--min-seconds', 300);
const CHAN = arg('--channel', null);

const files = fs.readdirSync(TR).filter(f => f.endsWith('.json'));
const rows = []; let skipped = 0, unreadable = 0;
for (const f of files) {
  let t; try { t = JSON.parse(fs.readFileSync(path.join(TR, f), 'utf8')); } catch { unreadable++; continue; }
  const r = analyse(t);
  if (!r) { skipped++; continue; }
  if (CHAN && r.channelId !== CHAN) continue;
  if (r.durationSec < MIN) { skipped++; continue; }
  rows.push(r);
}
rows.sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));

const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
const rate = (a, k) => sum(a, k) / sum(a, 'words') * 100;

console.log(`scanned ${files.length} transcripts — ${rows.length} qualify ` +
  `(>=${MIN}s${CHAN ? ', channel ' + CHAN : ''}), ${skipped} skipped, ${unreadable} unreadable\n`);

console.log('OVERALL');
console.log(`  words            ${sum(rows, 'words').toLocaleString()}`);
console.log(`  runtime          ${(sum(rows, 'durationSec') / 3600).toFixed(1)} hours`);
console.log(`  hard disfluency  ${sum(rows, 'hard').toLocaleString()}  (${rate(rows, 'hard').toFixed(2)} per 100 words)`);
console.log(`  stutter repeats  ${sum(rows, 'rep').toLocaleString()}  (${rate(rows, 'rep').toFixed(2)} per 100 words)`);
console.log(`  hedges           ${sum(rows, 'hedge').toLocaleString()}  (${rate(rows, 'hedge').toFixed(2)} per 100 words)  [ambiguous]`);
console.log(`  est. time on hard disfluencies: ${(sum(rows, 'hardSec') / 60).toFixed(0)} minutes of ${(sum(rows, 'durationSec') / 3600).toFixed(1)} hours`);

const allHard = {};
for (const r of rows) for (const [k, v] of Object.entries(r.hardBreak)) allHard[k] = (allHard[k] || 0) + v;
console.log('\n  which tokens: ' + Object.entries(allHard).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', '));

const allHedge = {};
for (const r of rows) for (const [k, v] of Object.entries(r.hedgeBreak)) allHedge[k] = (allHedge[k] || 0) + v;
console.log('  hedges       : ' + Object.entries(allHedge).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `"${k}" ${v.toLocaleString()}`).join(', '));

// ---- monthly trend -------------------------------------------------------
const byMonth = {};
for (const r of rows) {
  const m = String(r.publishedAt).slice(0, 7);
  (byMonth[m] || (byMonth[m] = [])).push(r);
}
const months = Object.keys(byMonth).sort();
console.log('\nMONTHLY (videos, words, hard/100w, stutter/100w, hedge/100w, wpm)');
for (const m of months) {
  const a = byMonth[m];
  const bar = '#'.repeat(Math.round(rate(a, 'hard') * 6));
  console.log('  ' + m + '  ' + String(a.length).padStart(4) + '  ' +
    String(sum(a, 'words')).padStart(8) + '  ' +
    rate(a, 'hard').toFixed(2).padStart(6) + '  ' +
    rate(a, 'rep').toFixed(2).padStart(7) + '  ' +
    rate(a, 'hedge').toFixed(2).padStart(7) + '  ' +
    (sum(a, 'words') / (sum(a, 'durationSec') / 60)).toFixed(0).padStart(4) + '  ' + bar);
}

// ---- extremes ------------------------------------------------------------
const recent = rows.slice(-60);
console.log('\nMOST DISFLUENT (last 60 qualifying uploads)');
for (const r of recent.slice().sort((a, b) => b.hardPer100 - a.hardPer100).slice(0, 8)) {
  console.log(`  ${r.hardPer100.toFixed(2)}/100w  ${String(r.hard).padStart(3)} tokens  ${String(r.publishedAt).slice(0, 10)}  ${r.title.slice(0, 44)}`);
}
console.log('\nLEAST DISFLUENT (last 60)');
for (const r of recent.slice().sort((a, b) => a.hardPer100 - b.hardPer100).slice(0, 5)) {
  console.log(`  ${r.hardPer100.toFixed(2)}/100w  ${String(r.hard).padStart(3)} tokens  ${String(r.publishedAt).slice(0, 10)}  ${r.title.slice(0, 44)}`);
}


// ---- diagnostic: is this measuring HIM or the transcriber? ----------------
// A real change in speech habits slides the whole distribution. A change in the
// captioning system makes videos flip to EXACTLY zero disfluencies while the
// rest stay normal. `zero%` separates the two, and it matters: before July 2020
// roughly half of all uploads contain no "uh" or "um" at all, which no human
// managed — those captions simply did not transcribe disfluencies. Rates from
// that era are not comparable with later ones.
if (args.includes('--diagnose')) {
  const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  console.log('\nDIAGNOSTIC — month, n, share with zero disfluencies, then the distribution');
  console.log('month      n   zero%   p10   median    p90');
  for (const m of months) {
    const a = byMonth[m];
    const r = a.map(x => x.hardPer100).sort((x, y) => x - y);
    const q = p => r[Math.floor(p * (r.length - 1))];
    console.log('  ' + m + String(a.length).padStart(5) +
      (a.filter(x => x.hard === 0).length / a.length * 100).toFixed(0).padStart(7) + '%' +
      q(0.1).toFixed(2).padStart(7) + med(r).toFixed(2).padStart(8) + q(0.9).toFixed(2).padStart(8));
  }
}

const out = arg('--json', null);
if (out) { fs.writeFileSync(out, JSON.stringify({ generated: null, minSeconds: MIN, channel: CHAN, rows })); console.log(`\nwrote ${out} (${rows.length} rows)`); }

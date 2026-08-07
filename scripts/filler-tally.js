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
  // ---- the single combined figure ----------------------------------------
  // The three tallies above OVERLAP: "uh uh" is two disfluencies and a repeat,
  // "like like" is two hedges and a repeat. Adding them would double-count. So
  // mark filler at the TOKEN level and count distinct marked words — that gives
  // an honest "share of everything he says", and the unit becomes words rather
  // than occurrences, which is what a per-100-words figure should mean.
  const HEDGE_UNI_SET = new Set(HEDGE_UNI);
  const mark = new Array(toks.length).fill(false);
  for (let i = 0; i < toks.length; i++) {
    if (HARD.has(toks[i])) mark[i] = true;
    if (HEDGE_UNI_SET.has(toks[i])) mark[i] = true;
    // Only the redundant second instance is filler; the first said something.
    if (i > 0 && toks[i] === toks[i - 1] && !OK_DOUBLE.has(toks[i])) mark[i] = true;
  }
  for (const [a, b] of HEDGE_BI) {
    for (let i = 1; i < toks.length; i++) if (toks[i - 1] === a && toks[i] === b) { mark[i - 1] = true; mark[i] = true; }
  }
  const fillerWords = mark.reduce((s, x) => s + (x ? 1 : 0), 0);

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
    fillerWords, fillerPer100: +(fillerWords / toks.length * 100).toFixed(2),
    fillerSec: +((fillerWords / toks.length) * dur).toFixed(1),
  };
}

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const MIN = +arg('--min-seconds', 300);
const CHAN = arg('--channel', null);
// Default cutoff. YouTube rolled disfluency transcription out gradually through
// July 2020 — before it, half of all uploads contain zero "uh"/"um", and mid-July
// the per-day rate climbs while zero-disfluency videos are still appearing. August
// is the first clean month (2% zero), so everything earlier is excluded by default.
// Pass --since 1970 to include it anyway, but the rates are not comparable.
const SINCE = arg('--since', '2020-08');

const files = fs.readdirSync(TR).filter(f => f.endsWith('.json'));
const rows = []; let skipped = 0, unreadable = 0, preCutoff = 0;
for (const f of files) {
  let t; try { t = JSON.parse(fs.readFileSync(path.join(TR, f), 'utf8')); } catch { unreadable++; continue; }
  const r = analyse(t);
  if (!r) { skipped++; continue; }
  if (CHAN && r.channelId !== CHAN) continue;
  if (r.durationSec < MIN) { skipped++; continue; }
  if (SINCE && String(r.publishedAt).slice(0, 7) < SINCE) { preCutoff++; continue; }
  rows.push(r);
}
rows.sort((a, b) => String(a.publishedAt).localeCompare(String(b.publishedAt)));

const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
const rate = (a, k) => sum(a, k) / sum(a, 'words') * 100;

console.log(`scanned ${files.length} transcripts — ${rows.length} qualify ` +
  `(>=${MIN}s${CHAN ? ', channel ' + CHAN : ''}${SINCE ? ', from ' + SINCE : ''}), ` +
  `${skipped} too short, ${preCutoff} before the cutoff, ${unreadable} unreadable`);
if (SINCE) console.log(`  pre-${SINCE} uploads excluded — YouTube did not transcribe disfluencies then`);

const totalWords = sum(rows, 'words');
const hrs = sum(rows, 'durationSec') / 3600;
const tok = k => rows.reduce((s, r) => s + (r.hardBreak[k] || 0), 0);
// Words are near-isochronous across a corpus this size, so share-of-words is a
// fair proxy for share-of-time. An estimate, stated as one.
const mins = n => (n / totalWords) * hrs * 60;
const line = (label, n, note) => console.log('  ' + label.padEnd(22) + n.toLocaleString().padStart(9) +
  (n / totalWords * 100).toFixed(2).padStart(10) + mins(n).toFixed(0).padStart(8) + '   ' + (note || ''));

console.log(`\nOVERALL — ${totalWords.toLocaleString()} words over ${hrs.toFixed(0)} hours, ${rows.length} videos\n`);
console.log('  ' + 'tally'.padEnd(22) + 'count'.padStart(9) + 'per 100w'.padStart(10) + '~mins'.padStart(8));
line('uh', tok('uh'));
line('um / umm', tok('um') + tok('umm'));
line('hmm / mhm / mm', tok('hmm') + tok('mhm') + tok('mm'));
line('DISFLUENCY total', sum(rows, 'hard'), 'unambiguous');
console.log('');
line('stutter repeats', sum(rows, 'rep'), '"if if you" — allowlist applied');
line('  before allowlist', sum(rows, 'repAll'), 'includes "very very" etc');
console.log('');
line('COUNTABLE TOTAL', sum(rows, 'hard') + sum(rows, 'rep'), 'disfluency + stutter');
console.log('');
line('hedges', sum(rows, 'hedge'), 'AMBIGUOUS — never added in');

// The one number: distinct words that are filler, overlaps resolved.
const fw = sum(rows, 'fillerWords');
console.log('\n  ' + '-'.repeat(62));
line('VERBAL FILLER', fw, 'all of the above, de-overlapped');
console.log('  ' + '-'.repeat(62));
console.log(`\n  ${(fw / totalWords * 100).toFixed(2)} of every 100 words he speaks is verbal filler`);
console.log(`  = 1 word in ${(totalWords / fw).toFixed(1)}, about ${(mins(fw) / 60).toFixed(0)} hours of the ${hrs.toFixed(0)} scanned`);

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

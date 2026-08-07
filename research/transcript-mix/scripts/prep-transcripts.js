// Build 30-second blocks from recent long-form transcripts, plus cheap objective
// stats (filler-word rate, words/min) as a cross-check on the LLM classification.
const fs = require('fs');
const path = require('path');
const TR = 'C:/tmp/transcripts-repo/transcripts';
const OUT = 'C:/Users/bradw/AppData/Local/Temp/claude/d--Personal-Code-Repos/f81c5bfb-43aa-4a8b-b133-119563e13730/scratchpad';
const data = JSON.parse(fs.readFileSync('D:/Personal/Code Repos/jerminaldecline/public/data.json', 'utf8'));
const TQ = 'UCfwE_ODI1YTbdjkzuSi1Nag';

// Recent long-form from the main channel, newest first, that actually have a transcript.
const cands = (data.videos || [])
  .filter(v => v.channelId === TQ && !v.isShort && !v.unavailable && (v.durationSec || 0) > 300)
  .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))
  .filter(v => fs.existsSync(path.join(TR, v.id + '.json')))
  .slice(0, 12);

const FILLER = /\b(um|uh|erm|like|you know|i mean|sort of|kind of|basically|literally|honestly|obviously|actually|right\?|okay so|anyway|whatever|blah)\b/gi;
const rows = [];
const index = [];

for (const v of cands) {
  const t = JSON.parse(fs.readFileSync(path.join(TR, v.id + '.json'), 'utf8'));
  const segs = t.segments || [];
  if (!segs.length) continue;
  // fold segments into ~30s blocks, keeping the start time
  const BLOCK = 30000;
  const blocks = [];
  let cur = { start: 0, text: [] };
  for (const s of segs) {
    if (s.offset >= cur.start + BLOCK && cur.text.length) {
      blocks.push({ start: cur.start, text: cur.text.join(' ') });
      cur = { start: s.offset, text: [] };
    }
    cur.text.push((s.text || '').replace(/\s+/g, ' ').trim());
  }
  if (cur.text.length) blocks.push({ start: cur.start, text: cur.text.join(' ') });

  const all = segs.map(s => s.text).join(' ');
  const words = all.split(/\s+/).filter(Boolean).length;
  const fillerHits = (all.match(FILLER) || []).length;
  const spokenMs = segs.reduce((s, x) => s + (x.duration || 0), 0);
  const lastMs = segs[segs.length - 1].offset + (segs[segs.length - 1].duration || 0);

  rows.push({
    id: v.id, title: v.title, dur: v.durationSec, blocks: blocks.length, words,
    wpm: +(words / (v.durationSec / 60)).toFixed(0),
    fillerPer100: +(fillerHits / words * 100).toFixed(2),
    coverage: +(lastMs / 1000 / v.durationSec * 100).toFixed(0),
  });

  const mmss = ms => { const s = Math.round(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  fs.writeFileSync(path.join(OUT, 'tr-' + v.id + '.txt'),
    `VIDEO: ${v.title}\nRUNTIME: ${Math.round(v.durationSec / 60)} min\n\n` +
    blocks.map((b, i) => `[${i + 1}] ${mmss(b.start)}  ${b.text}`).join('\n\n'));
  index.push({ id: v.id, title: v.title, dur: v.durationSec, blocks: blocks.length });
}

fs.writeFileSync(path.join(OUT, 'tr-index.json'), JSON.stringify(index, null, 1));
console.log('sample: ' + rows.length + ' long-form videos with transcripts\n');
console.log('id'.padEnd(13) + 'min'.padStart(4) + 'blocks'.padStart(7) + 'words'.padStart(7) + 'wpm'.padStart(5) + ' filler/100w  cov%  title');
for (const r of rows) {
  console.log(r.id.padEnd(13) + String(Math.round(r.dur / 60)).padStart(4) + String(r.blocks).padStart(7) +
    String(r.words).padStart(7) + String(r.wpm).padStart(5) + String(r.fillerPer100).padStart(11) +
    String(r.coverage).padStart(6) + '  ' + r.title.slice(0, 40));
}
const avg = k => (rows.reduce((s, r) => s + r[k], 0) / rows.length).toFixed(1);
console.log('\naverages: ' + avg('wpm') + ' wpm, ' + avg('fillerPer100') + ' filler words per 100, transcript covers ' + avg('coverage') + '% of runtime');
console.log('total blocks to classify: ' + rows.reduce((s, r) => s + r.blocks, 0));

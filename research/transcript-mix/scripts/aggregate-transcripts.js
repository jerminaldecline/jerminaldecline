// Aggregate the transcript classification: share of runtime by category, per video
// and overall, plus the independent auditor's agreement rate.
const fs = require('fs');
const OUT = "C:/Users/bradw/AppData/Local/Temp/claude/d--Personal-Code-Repos/f81c5bfb-43aa-4a8b-b133-119563e13730/tasks/w5imlqk29.output";
const idx = JSON.parse(fs.readFileSync('tr-index.json', 'utf8'));
const meta = {}; idx.forEach(v => meta[v.id] = v);

const top = JSON.parse(fs.readFileSync(OUT, "utf8"));
const perVideo = {};
for (const v of (top.result.classified || [])) if (v && v.id) perVideo[v.id] = v;
const auditItems = (top.result.audit && top.result.audit.items) || null;

const CATS = ['S', 'Q', 'F', 'P'];
const NAME = { S: 'Substance', Q: 'Source read', F: 'Filler', P: 'Promo' };
console.log('SHARE OF RUNTIME BY CATEGORY (blocks are ~30s each)\n');
console.log('video          min   ' + CATS.map(c => NAME[c].padStart(12)).join('') + '   filler mins');

const totals = { S: 0, Q: 0, F: 0, P: 0 }; let totalBlocks = 0;
const rows = [];
for (const v of idx) {
  const r = perVideo[v.id]; if (!r) { console.log(v.id + '  (missing)'); continue; }
  const c = { S: 0, Q: 0, F: 0, P: 0 };
  for (const b of r.blocks) if (c[b.cat] !== undefined) c[b.cat]++;
  const n = r.blocks.length; totalBlocks += n;
  CATS.forEach(k => totals[k] += c[k]);
  const mins = Math.round(v.dur / 60);
  const pct = k => (c[k] / n * 100);
  rows.push({ id: v.id, title: v.title, n, c, pct: Object.fromEntries(CATS.map(k => [k, pct(k)])), mins });
  console.log(v.id.padEnd(13) + String(mins).padStart(4) + '   ' +
    CATS.map(k => (pct(k).toFixed(0) + '%').padStart(12)).join('') +
    ('  ' + (c.F * 0.5).toFixed(1) + ' min').padStart(14));
}
console.log('\nOVERALL (' + totalBlocks + ' blocks ≈ ' + Math.round(totalBlocks * 0.5) + ' minutes of video)');
for (const k of CATS) {
  const pc = totals[k] / totalBlocks * 100;
  console.log('  ' + NAME[k].padEnd(13) + (pc.toFixed(1) + '%').padStart(7) + '  ' + '#'.repeat(Math.round(pc / 2)));
}
const perVid14 = k => (totals[k] / totalBlocks * 14).toFixed(1);
console.log('\n  In a typical 14-minute video: ' + CATS.map(k => NAME[k] + ' ' + perVid14(k) + ' min').join(' · '));

// spread
const f = rows.map(r => r.pct.F).sort((a, b) => a - b);
console.log('\n  Filler ranges from ' + f[0].toFixed(0) + '% to ' + f[f.length - 1].toFixed(0) + '% across the 12 videos');
const worst = rows.slice().sort((a, b) => b.pct.F - a.pct.F)[0];
const best = rows.slice().sort((a, b) => a.pct.F - b.pct.F)[0];
console.log('   most padded : ' + worst.pct.F.toFixed(0) + '%  ' + worst.title);
console.log('   least padded: ' + best.pct.F.toFixed(0) + '%  ' + best.title);

// --- auditor agreement -----------------------------------------------------
if (auditItems) {
  let agree = 0, total = 0; const confusion = {};
  for (const it of auditItems) {
    const m = /^(.+)#(\d+)$/.exec(it.key || ''); if (!m) continue;
    const r = perVideo[m[1]]; if (!r) continue;
    const orig = (r.blocks.find(b => b.n === +m[2]) || {}).cat; if (!orig) continue;
    total++; if (orig === it.cat) agree++;
    else { const k = orig + '->' + it.cat; confusion[k] = (confusion[k] || 0) + 1; }
  }
  console.log('\n=== AUDITOR AGREEMENT (48 blocks re-rated blind, no surrounding context) ===');
  console.log('  agreed on ' + agree + '/' + total + ' = ' + (agree / total * 100).toFixed(0) + '%');
  console.log('  disagreements: ' + Object.entries(confusion).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => k + ' ×' + n).join(', '));
}

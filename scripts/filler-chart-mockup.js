// Mock up the "verbal filler over time" chart in the site's own visual language.
// Both series are per-100-words, so they share one axis — no dual-axis fudge.
// Input is the --json output of filler-tally.js.
//   node filler-tally.js --channel <id> --json filler.json
//   node filler-chart-mockup.js filler.json chart.html
const fs = require('fs');
const IN = process.argv[2] || 'filler.json';
const OUT = process.argv[3] || 'chart-filler.html';
const rows = JSON.parse(fs.readFileSync(IN, 'utf8')).rows;

const byMonth = {};
for (const r of rows) (byMonth[String(r.publishedAt).slice(0, 7)] ||= []).push(r);
const months = Object.keys(byMonth).sort();
const series = months.map(m => {
  const a = byMonth[m];
  const w = a.reduce((s, r) => s + r.words, 0);
  return {
    m, n: a.length, words: w,
    hard: a.reduce((s, r) => s + r.hard, 0) / w * 100,
    rep: a.reduce((s, r) => s + r.rep, 0) / w * 100,
  };
});
// The current month is still filling up; mark it rather than pretend it's final.
const partial = series[series.length - 1];

const W = 1000, H = 440, L = 54, R = 118, T = 34, B = 46;
const pw = W - L - R, ph = H - T - B;
const maxY = 2.2;
const x = i => L + (i / (series.length - 1)) * pw;
const y = v => T + ph - (v / maxY) * ph;

const pathOf = k => series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[k]).toFixed(1)}`).join('');

// gridlines + year ticks
let grid = '';
for (let v = 0; v <= maxY; v += 0.5) {
  grid += `<line x1="${L}" y1="${y(v)}" x2="${L + pw}" y2="${y(v)}" class="grid"/>` +
    `<text x="${L - 10}" y="${y(v) + 4}" class="ax ar">${v.toFixed(1)}</text>`;
}
let ticks = '';
series.forEach((s, i) => {
  if (!s.m.endsWith('-01')) return;
  ticks += `<line x1="${x(i)}" y1="${T}" x2="${x(i)}" y2="${T + ph}" class="grid yr"/>` +
    `<text x="${x(i)}" y="${T + ph + 20}" class="ax mid">${s.m.slice(0, 4)}</text>`;
});

// the sustained drop: first month of the new level onward
const shiftIdx = series.findIndex(s => s.m === '2026-04');
const shade = shiftIdx > 0
  ? `<rect x="${x(shiftIdx)}" y="${T}" width="${L + pw - x(shiftIdx)}" height="${ph}" class="band"/>`
  : '';

const lastHard = series[series.length - 1].hard, lastRep = series[series.length - 1].rep;
// Pre-shift baseline for the annotation
const base = series.filter(s => s.m >= '2025-01' && s.m < '2026-04');
const baseHard = base.reduce((s, r) => s + r.hard, 0) / base.length;
const post = series.filter(s => s.m >= '2026-04');
const postHard = post.reduce((s, r) => s + r.hard, 0) / post.length;

const html = `<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verbal filler over time — mockup</title>
<style>
:root{--brand:#6aa3ff;--bg:#0d1220;--surface:#161c2e;--surface-2:#1d2538;--border:#29314a;
  --text:#ede8d8;--text-muted:#9aa0b3;--text-dim:#6c728a;--accent-2:#e0a458;--down:#ff6b66;--label:#b9c0d0;}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--text);margin:0;padding:26px;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.card{max-width:1060px;margin:0 auto;background:var(--surface);border:1px solid var(--border);
  border-radius:14px;padding:1.5rem 1.6rem}
.eyebrow{font-family:ui-monospace,Consolas,monospace;font-size:0.66rem;letter-spacing:0.16em;
  text-transform:uppercase;color:var(--text-dim);margin-bottom:7px}
h3{font-size:1.15rem;font-weight:800;letter-spacing:-0.01em;margin:0 0 0.25rem}
.sub{font-size:0.85rem;color:var(--text-muted);margin:0 0 1.2rem;line-height:1.5;max-width:74ch}
.key{display:flex;gap:1.4rem;align-items:center;margin:0 0 0.5rem;font-size:0.83rem;flex-wrap:wrap}
.key span{display:flex;align-items:center;gap:0.45rem;color:var(--label)}
.sw{width:16px;height:3px;border-radius:2px;display:inline-block}
svg{width:100%;height:auto;display:block}
.grid{stroke:var(--border);stroke-width:1}
.grid.yr{stroke-dasharray:2 4;opacity:0.55}
.ax{fill:var(--text-dim);font-size:11px;font-variant-numeric:tabular-nums}
.ar{text-anchor:end}.mid{text-anchor:middle}
.ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.band{fill:#6aa3ff;opacity:0.07}
.note{fill:var(--text-muted);font-size:11.5px}
.note b{fill:var(--text)}
.dlab{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}
.foot{margin-top:1.1rem;padding-top:0.85rem;border-top:1px solid var(--border);
  font-size:0.76rem;color:var(--text-dim);line-height:1.6;max-width:86ch}
.foot b{color:var(--text-muted);font-weight:600}
</style>
<div class="card">
  <div class="eyebrow">Transcript study &middot; mockup</div>
  <h3>Is he still saying &ldquo;uh&rdquo;?</h3>
  <p class="sub">Verbal filler per 100 spoken words, every long-form upload on TheQuartering,
    month by month. Counted directly from the transcripts &mdash; no interpretation, no sampling.</p>
  <div class="key">
    <span><i class="sw" style="background:var(--brand)"></i> Disfluencies &mdash; &ldquo;uh&rdquo;, &ldquo;um&rdquo;</span>
    <span><i class="sw" style="background:var(--accent-2)"></i> Stutter repeats &mdash; &ldquo;if if you&rdquo;</span>
    <span style="color:var(--text-dim)"><i class="sw" style="background:#6aa3ff;opacity:0.25"></i> since Apr 2026</span>
  </div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Verbal filler per 100 words by month, August 2020 to August 2026">
    ${shade}${grid}${ticks}
    <text x="${L}" y="${T - 14}" class="ax" style="text-anchor:start">per 100 words</text>
    <path d="${pathOf('hard')}" class="ln" stroke="var(--brand)"/>
    <path d="${pathOf('rep')}" class="ln" stroke="var(--accent-2)"/>
    <circle cx="${x(series.length - 1)}" cy="${y(lastHard)}" r="4" fill="var(--bg)" stroke="var(--brand)" stroke-width="2"/>
    <circle cx="${x(series.length - 1)}" cy="${y(lastRep)}" r="4" fill="var(--bg)" stroke="var(--accent-2)" stroke-width="2"/>
    ${/* The two series converge at the end, so the labels have to be pushed
          apart by hand or they print on top of each other. */''}
    <text x="${x(series.length - 1) + 12}" y="${y(lastHard) - 5}" class="dlab" fill="var(--brand)">${lastHard.toFixed(2)}</text>
    <text x="${x(series.length - 1) + 12}" y="${y(lastRep) + 15}" class="dlab" fill="var(--accent-2)">${lastRep.toFixed(2)}</text>
    ${/* Annotation sits LEFT of the band, right-aligned: the band starts close to
          the plot edge and left-aligned text ran off the card. */''}
    <text x="${x(shiftIdx) - 14}" y="${T + 22}" class="note" style="text-anchor:end"><tspan font-weight="700" fill="#ede8d8">Apr 2026:</tspan> disfluencies halve,</text>
    <text x="${x(shiftIdx) - 14}" y="${T + 39}" class="note" style="text-anchor:end">${baseHard.toFixed(2)} &#8594; ${postHard.toFixed(2)} per 100 words &mdash;</text>
    <text x="${x(shiftIdx) - 14}" y="${T + 56}" class="note" style="text-anchor:end">while <tspan fill="var(--accent-2)" font-weight="700">stutters rise</tspan></text>
    <line x1="${x(shiftIdx) - 10}" y1="${T + 34}" x2="${x(shiftIdx) - 2}" y2="${T + 34}" class="grid" style="stroke:var(--text-dim)"/>
  </svg>
  <div class="foot">
    <b>What is counted:</b> &ldquo;uh&rdquo;, &ldquo;um&rdquo;, &ldquo;hmm&rdquo; and immediate word repeats,
    from ${(rows.reduce((s, r) => s + r.words, 0) / 1e6).toFixed(1)}M words across ${rows.length.toLocaleString()} uploads.
    Hedges like &ldquo;you know&rdquo; and &ldquo;like&rdquo; are tracked separately and deliberately left out &mdash;
    &ldquo;like&rdquo; is usually just a preposition.
    <br><b>Why it starts in August 2020:</b> YouTube did not transcribe disfluencies before then. Half of all
    earlier uploads contain no &ldquo;uh&rdquo; or &ldquo;um&rdquo; at all, which no human manages, so those
    years cannot be compared with these and are excluded rather than shown as a fake improvement.
    <br><b>Last point:</b> ${partial.m} is still in progress (${partial.n} uploads so far).
  </div>
</div>`;
fs.writeFileSync(OUT, html);
console.log(`wrote ${OUT} — ${series.length} months, ${series[0].m} to ${series[series.length - 1].m}`);
console.log(`baseline 2025-01..2026-03: ${baseHard.toFixed(2)}   since 2026-04: ${postHard.toFixed(2)}  (${((postHard / baseHard - 1) * 100).toFixed(0)}%)`);
const bRep = base.reduce((s, r) => s + r.rep, 0) / base.length, pRep = post.reduce((s, r) => s + r.rep, 0) / post.length;
console.log(`stutters  baseline ${bRep.toFixed(2)}   since ${pRep.toFixed(2)}  (+${((pRep / bRep - 1) * 100).toFixed(0)}%)`);

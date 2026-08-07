// Rebuild public/transcript-mix.json from the two-rater re-audit.
//
// Differences from the first version (build-mix.js):
//   * scores are proportional per block, not one label per block, so a block that
//     is half quote and half his own point is counted as half of each;
//   * blocks are weighted by their real duration (they run 4.5s to 35.2s, not a
//     flat 30) so the published figure is genuinely share-of-runtime;
//   * agreement is measured over all 333 blocks by two different models, not over
//     a 48-block sample by one.
const fs = require('fs');
const path = require('path');
const HERE = __dirname;
const TR = 'C:/tmp/transcripts-repo/transcripts';
const OUT = 'D:/Personal/Code Repos/jerminaldecline/public/transcript-mix.json';
const CATS = ['S', 'Q', 'F', 'P'];

const audit = JSON.parse(fs.readFileSync(path.join(HERE, 'reaudit-final.json'), 'utf8'));
const durs = JSON.parse(fs.readFileSync(path.join(HERE, 'block-durations.json'), 'utf8'));
const idx = JSON.parse(fs.readFileSync(path.join(HERE, 'tr-index.json'), 'utf8'));

// One verbatim example per bucket, from blocks the raters agreed on. Re-verified
// against the final scores below — an example must still be dominated by its bucket.
const EXAMPLES = {
  S: { quote: "They don't actually believe what they're saying. They're only saying it for money.", from: '4gJvZoDWh7w', block: 7 },
  Q: { quote: 'Just hearing about this dumb $20 burrito debate\u2026 stop whining and get a job.', from: 'VYD--C8hJ4I', block: 23, note: 'reading a post aloud' },
  // Replaced after the re-audit: the old filler quote sat in a block that scores
  // 0.5 substance / 0.4 filler, so it no longer illustrated its own bucket.
  F: { quote: 'Can we just get our lettuce from America? \u2026 Is it that hard? \u2026 Is it that hard to just get our lettuce from America?', from: 'yVm_CeJYFCc', block: 17 },
  P: { quote: 'If you enjoyed the video, make sure you leave a like on it. Subscribe or follow down below.', from: 'MScY2xohqsE', block: 25 },
};

const meta = id => {
  const t = JSON.parse(fs.readFileSync(TR + '/' + id + '.json', 'utf8'));
  const segs = t.segments || [];
  const lastMs = segs.length ? segs[segs.length - 1].offset + (segs[segs.length - 1].duration || 0) : 0;
  return { title: t.title || '', publishedAt: t.publishedAt || null, durationSec: Math.round(lastMs / 1000) };
};

const out = [];
let missing = 0;
for (const v of idx) {
  const d = durs[v.id] || [];
  const sec = { S: 0, Q: 0, F: 0, P: 0 };
  let counted = 0, blocks = 0;
  for (let i = 0; i < d.length; i++) {
    const s = audit.scores[v.id + '#' + (i + 1)];
    blocks++;
    if (!s) { missing++; continue; }
    for (const k of CATS) sec[k] += (s[k] || 0) * d[i];
    counted += d[i];
  }
  const m = meta(v.id);
  out.push({
    id: v.id, title: m.title, publishedAt: m.publishedAt, durationSec: m.durationSec,
    blocks, secTotal: +counted.toFixed(1),
    ...Object.fromEntries(CATS.map(k => [k, +sec[k].toFixed(1)])),
  });
}
out.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));

const tot = { S: 0, Q: 0, F: 0, P: 0, secTotal: 0, blocks: 0 };
for (const v of out) { for (const k of CATS) tot[k] += v[k]; tot.secTotal += v.secTotal; tot.blocks += v.blocks; }

// Sanity: every example must still be dominated by the bucket it illustrates.
for (const [k, eg] of Object.entries(EXAMPLES)) {
  const s = audit.scores[eg.from + '#' + eg.block];
  if (!s) { console.warn(`  ! example for ${k}: block not scored`); continue; }
  const dom = CATS.reduce((a, c) => (s[c] > s[a] ? c : a), 'S');
  const flag = dom === k ? 'ok' : '!! now dominated by ' + dom;
  console.log(`  example ${k} (${eg.from}#${eg.block}): ` +
    CATS.map(c => c + (s[c] || 0).toFixed(1)).join(' ') + `  ${flag}`);
}

// How filler is distributed, not just how much there is. It turns out no single
// block is even two-thirds filler — padding is woven through rather than pooled,
// which is a more interesting claim than the headline percentage.
const fShares = [];
for (const v of idx) {
  const d = durs[v.id] || [];
  for (let i = 0; i < d.length; i++) {
    const s2 = audit.scores[v.id + '#' + (i + 1)];
    if (s2) fShares.push(s2.F || 0);
  }
}
const maxBlockFiller = Math.max(...fShares);
const underFifth = fShares.filter(x => x < 0.2).length;

const pc = k => tot[k] / tot.secTotal * 100;
const agree = Math.round(audit.agreement * 100);
const doc = {
  _note: "How a long-form video's runtime actually breaks down. Auto-generated transcripts were cut into ~30-second blocks and each block scored for how its time divides between the presenter's own substance, source material read aloud, filler, and promotion. A one-off study, not a live feed.",
  _method: `The 12 most recent long-form uploads on TheQuartering that have transcripts, as of 2026-08-07 — ${tot.blocks} blocks covering ${Math.round(tot.secTotal / 60)} minutes. Every block was scored twice, independently, by two different models, each shown the neighbouring blocks for context. Rather than forcing one label per block, each rater split the block's time across the four categories, so a block that is half quotation and half his own point counts as half of each. The two agreed on ${agree}% of blocks; the ${audit.disputes} where they materially disagreed were settled by a third pass with a wider window of transcript. Blocks are weighted by their real duration.`,
  _caveat: "Substance vs read-aloud is the softest line, because auto-transcripts carry no quotation marks. Where a rater was genuinely torn the rules told it to favour substance over filler, so the filler figure is a floor rather than a ceiling. The combined 'not filler, not promo' share is the firmer number.",
  _generated: '2026-08-07',
  _sample: {
    videos: out.length, blocks: tot.blocks, minutes: Math.round(tot.secTotal / 60),
    agreement: +(audit.agreement).toFixed(2), disputes: audit.disputes, raters: 2,
    mad: +(audit.madPct || 0).toFixed(1),
  },
  _totals: Object.fromEntries(CATS.map(k => [k, +tot[k].toFixed(1)])),
  _totalSeconds: +tot.secTotal.toFixed(1),
  _texture: {
    maxBlockFiller: +maxBlockFiller.toFixed(2),
    underFifth, blocks: fShares.length,
  },
  categories: { S: 'Own substance', Q: 'Read aloud', F: 'Filler', P: 'Promo' },
  examples: EXAMPLES,
  videos: out,
};
fs.writeFileSync(OUT, JSON.stringify(doc));
if (missing) console.warn(`\n  ! ${missing} blocks had no score and were excluded from the weighting`);
console.log(`\nwrote transcript-mix.json — ${out.length} videos, ${tot.blocks} blocks, ${(tot.secTotal / 60).toFixed(1)} min`);
console.log('overall: ' + CATS.map(k => `${{ S: 'substance', Q: 'read-aloud', F: 'filler', P: 'promo' }[k]} ${pc(k).toFixed(1)}%`).join('  '));
console.log('in a 14-min upload: ' + CATS.map(k => `${{ S: 'S', Q: 'Q', F: 'F', P: 'P' }[k]} ${(pc(k) / 100 * 14).toFixed(1)}min`).join('  '));
console.log('\nper video, most padded first:');
for (const v of out.slice().sort((a, b) => b.F / b.secTotal - a.F / a.secTotal)) {
  console.log('  ' + String(Math.round(v.F / v.secTotal * 100)).padStart(3) + '% filler   ' + v.title.slice(0, 46));
}

#!/usr/bin/env node
/**
 * Re-file videos whose title names a person but whose subject tag is one of that
 * person's own films, shows or franchises.
 *
 * The LLM tagger gives each video exactly one subject. When a title names both a
 * person and a film ("Brie Larson Takes Back The Marvels"), the model has to pick
 * and picks the film about a third of the time, so the person is undercounted.
 * This is a deterministic correction, driven by small clusters declared in
 * public/topics.json on the PERSON's entry:
 *
 *   "brie-larson": { "name": "Brie Larson", ..., "related": ["captain-marvel", "the-marvels"],
 *                    "claims": ["marvel-studios", "disney"] }
 *
 *   related  - the person's own films/franchises. The site shows these under the
 *              person as well as on their own line, and the rule below moves a
 *              video from a related tag to the person when the title names them.
 *   claims   - broader tags that also cede to the person when the title names
 *              them (studios, parent companies). Not shown under the person.
 *
 * A video that was classified (has a mode) but has no subject at all is given the
 * person when the title names them.
 *
 * Runs on today's file and, in the refresh runner, after the tagger and before the
 * flattening guard, so new uploads get the same treatment. Idempotent.
 *
 * Usage:
 *   node scripts/apply-topic-clusters.js                   # main repo defaults, writes in place
 *   node scripts/apply-topic-clusters.js --tags <file> --topics <file> --data <file> [--dry]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const TAGS = opt('--tags', path.join(ROOT, 'public', 'topic-tags-llm.json'));
const TOPICS = opt('--topics', path.join(ROOT, 'public', 'topics.json'));
const DATA = opt('--data', path.join(ROOT, 'public', 'data.json'));
const DRY = args.includes('--dry');

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const llm = read(TAGS);
const topics = read(TOPICS);
const data = read(DATA);
const tags = llm.tags || {};
const modes = llm.modes || {};

// " brie larson " style keys so a name matches whole words only, punctuation ignored
const words = s => ' ' + String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';

const clusters = Object.entries(topics)
  .filter(([id, t]) => t && typeof t === 'object' && !id.startsWith('_') && (Array.isArray(t.related) || Array.isArray(t.claims)))
  .map(([id, t]) => ({ id, name: t.name || id, key: words(t.name || ''), cede: new Set([...(t.related || []), ...(t.claims || [])]) }));

if (!clusters.length) { console.log('apply-topic-clusters: no clusters declared in topics.json; nothing to do'); process.exit(0); }

const moved = {};
let total = 0;
for (const v of data.videos || []) {
  if (!v.title || v.isShort) continue;
  const tw = words(v.title);
  for (const c of clusters) {
    if (tw.indexOf(c.key) < 0) continue;
    const cur = tags[v.id];
    if (cur === c.id) break;
    const untagged = !cur && modes[v.id];
    if (!(untagged || c.cede.has(cur))) continue;
    const from = cur || '(untagged)';
    moved[c.id] = moved[c.id] || {};
    moved[c.id][from] = (moved[c.id][from] || 0) + 1;
    if (!DRY) tags[v.id] = c.id;
    total++;
    break;
  }
}

for (const c of clusters) {
  const m = moved[c.id];
  if (!m) { console.log(`  ${c.name}: nothing to move`); continue; }
  console.log(`  ${c.name}: ${Object.values(m).reduce((a, b) => a + b, 0)} moved (${Object.entries(m).map(([k, n]) => `${n} from ${k}`).join(', ')})`);
}
console.log(`apply-topic-clusters: ${total} video${total === 1 ? '' : 's'} re-filed${DRY ? ' (dry run, nothing written)' : ''}`);

if (!DRY && total) {
  llm.tags = tags;
  fs.writeFileSync(TAGS, JSON.stringify(llm));
}

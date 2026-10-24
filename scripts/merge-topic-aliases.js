#!/usr/bin/env node
/**
 * Fold spelling variants of a subject into one id.
 *
 * The tagger names a subject slightly differently from one video to the next
 * ("Cornell 7 case", "Cornell Seven", "John J. Griffin II" vs "John Griffin II"),
 * and the backfill files each spelling under its own id, so a saga splits in
 * the month it is happening. This script re-files every tag onto one id per
 * subject and drops the orphaned definitions. Two sources of truth:
 *
 *   1. Mechanical variants, found automatically: punctuation, a leading "The",
 *      number words ("Seven" -> "7"), a trailing "case"/"saga", and single-letter
 *      middle initials. Nothing else is guessed; "Sean Combs" and "Sean Diddy
 *      Combs" are different strings to this rule.
 *   2. public/topic-aliases.json, a hand-kept map of variant id -> subject id
 *      for the cases a rule cannot see.
 *
 * Which id survives a group: a promoted subject, then one another subject's
 * related/claims lists point at, then the one with the most videos, then the
 * shorter name. Idempotent; runs after backfill-topic-tags.js on every tagger
 * run. backfill-topic-tags.js also imports resolveSubjectId() from here so a
 * new spelling is matched to an existing subject instead of becoming a new id.
 *
 * Usage:
 *   node scripts/merge-topic-aliases.js            # main repo defaults, writes in place
 *   node scripts/merge-topic-aliases.js --dry      # report only, with candidates for the alias file
 *   node scripts/merge-topic-aliases.js --tags F --topics F --aliases F
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NUM = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };

const slugify = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// The comparison key: what is left of a name once the mechanical variation is removed.
function keyOf(name) {
  const s = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  let w = s.split(' ').filter(Boolean);
  if (w.length > 1 && w[0] === 'the') w.shift();
  w = w.map(t => NUM[t] || t);
  while (w.length > 1 && (w[w.length - 1] === 'case' || w[w.length - 1] === 'saga')) w.pop();
  if (w.length >= 3) w = [w[0], ...w.slice(1, -1).filter(t => t.length > 1), w[w.length - 1]];
  return w.join(' ');
}

function loadAliases(file) {
  if (!file || !fs.existsSync(file)) return {};
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (j && j.aliases) || {};
}

// Build variant -> canonical for every id in topics, from the automatic groups plus the alias file.
function buildCanonMap({ topics, tags, promoted, aliases }) {
  const count = new Map();
  for (const id of Object.values(tags || {})) count.set(id, (count.get(id) || 0) + 1);
  const referenced = new Set();
  for (const t of Object.values(topics)) if (t) for (const k of ['related', 'claims']) if (Array.isArray(t[k])) for (const r of t[k]) referenced.add(r);
  const score = id => (promoted.has(id) ? 1e6 : 0) + (referenced.has(id) ? 1e5 : 0) + (count.get(id) || 0) * 10 - Math.min(9, String((topics[id] || {}).name || '').length / 10);
  const groups = new Map();
  for (const [id, t] of Object.entries(topics)) {
    if (!t || t.kind !== 'subject') continue;
    const k = keyOf(t.name); if (!k) continue;
    (groups.get(k) || groups.set(k, []).get(k)).push(id);
  }
  const canon = {};
  const auto = [];
  for (const [k, ids] of groups) {
    if (ids.length < 2) continue;
    const best = [...ids].sort((a, b) => score(b) - score(a))[0];
    for (const id of ids) if (id !== best) canon[id] = best;
    auto.push({ key: k, canonical: best, variants: ids.filter(id => id !== best) });
  }
  const manual = [];
  for (const [from, to] of Object.entries(aliases)) {
    if (from === to) continue;
    if (!topics[to]) { manual.push({ from, to, problem: 'target id not in topics.json' }); continue; }
    canon[from] = to; manual.push({ from, to, known: !!topics[from] });
  }
  // Resolve chains (a -> b -> c) and refuse cycles.
  const resolve = id => { let cur = id, hops = 0; while (canon[cur] && hops < 10) { cur = canon[cur]; hops++; } return cur; };
  for (const id of Object.keys(canon)) { const end = resolve(id); if (end === id) delete canon[id]; else canon[id] = end; }
  return { canon, auto, manual, count, referenced, groups };
}

// For the backfill: the id a freshly stored subject name should be filed under, or null to create one.
function resolveSubjectId(name, topics, canonMap, groups) {
  const slug = slugify(name);
  if (!slug) return null;
  if (canonMap[slug]) return canonMap[slug];
  if (topics[slug] && topics[slug].kind === 'subject') return slug;
  const ids = (groups.get(keyOf(name)) || []).filter(id => topics[id] && topics[id].kind === 'subject');
  if (ids.length) { const id = ids[0]; return canonMap[id] || id; }
  return null;
}

function run() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  const TAGS = opt('--tags', path.join(ROOT, 'public', 'topic-tags-llm.json'));
  const TOPICS = opt('--topics', path.join(ROOT, 'public', 'topics.json'));
  const ALIASES = opt('--aliases', path.join(ROOT, 'public', 'topic-aliases.json'));
  const DRY = args.includes('--dry');
  const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  const llm = read(TAGS); const topics = read(TOPICS);
  const tags = llm.tags || {}; const promoted = new Set(llm._promotedSubjects || llm._promoted || []);
  const aliases = loadAliases(ALIASES);
  const { canon, auto, manual, count, referenced } = buildCanonMap({ topics, tags, promoted, aliases });

  const nameOf = id => (topics[id] && topics[id].name) || id;
  const show = id => `${nameOf(id)} (${count.get(id) || 0}${promoted.has(id) ? '*' : ''})`;
  console.log(`merge-topic-aliases: ${auto.length} automatic group${auto.length === 1 ? '' : 's'}, ${manual.length} alias${manual.length === 1 ? '' : 'es'} from file${DRY ? ' (dry run, nothing written)' : ''}`);
  for (const g of auto) console.log(`  auto   ${g.variants.map(show).join(', ')}  ->  ${show(g.canonical)}`);
  for (const m of manual) console.log(`  alias  ${show(m.from)}  ->  ${show(m.to)}${m.problem ? '   !! ' + m.problem : m.known ? '' : '   (variant id not present; kept for future spellings)'}`);

  let moved = 0; const touched = new Set();
  for (const [vid, id] of Object.entries(tags)) { const to = canon[id]; if (to && to !== id) { if (!DRY) tags[vid] = to; moved++; touched.add(id); } }
  let removed = 0;
  for (const id of Object.keys(canon)) {
    if (!topics[id] || promoted.has(id) || referenced.has(id)) continue;
    const stillTagged = DRY ? (count.get(id) || 0) > 0 && !touched.has(id) : Object.values(tags).includes(id);
    if (stillTagged) continue;
    if (!DRY) delete topics[id]; removed++;
  }
  console.log(`  ${moved} video${moved === 1 ? '' : 's'} re-filed, ${removed} orphaned definition${removed === 1 ? '' : 's'} removed`);

  if (DRY) {
    // Candidates for the alias file: names sharing first and last word but differing in the middle.
    const byEnds = new Map();
    for (const [id, t] of Object.entries(topics)) { if (!t || t.kind !== 'subject' || !(count.get(id))) continue; const w = keyOf(t.name).split(' '); if (w.length < 2) continue; const k = w[0] + ' ' + w[w.length - 1]; (byEnds.get(k) || byEnds.set(k, new Set()).get(k)).add(canon[id] || id); }
    const cands = [...byEnds.values()].filter(s => s.size > 1);
    if (cands.length) { console.log(`  ${cands.length} first+last-word collisions to eyeball for the alias file (ids in brackets):`); for (const s of cands) console.log('    ' + [...s].map(id => `${show(id)} [${id}]`).join('  |  ')); }
    return;
  }
  if (moved || removed) {
    fs.writeFileSync(TAGS, JSON.stringify(llm));
    fs.writeFileSync(TOPICS, JSON.stringify(topics));
  }
}

module.exports = { keyOf, slugify, loadAliases, buildCanonMap, resolveSubjectId };
if (require.main === module) run();

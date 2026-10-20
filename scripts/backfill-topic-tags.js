#!/usr/bin/env node
/**
 * Write the subject tags the tagger found but never recorded.
 *
 * tag-topics-llm.js stores the subject it identified for every video in
 * _subjectRaw, but only writes a tag (tags[videoId]) when that subject clears
 * the raw floor (three videos) within the same run. Incremental daily runs
 * process a handful of uploads, so recurring subjects almost never clear the
 * floor on the day, and the video stays untagged even after the subject exists
 * as a topic from some other day. This script joins those videos to their
 * subject deterministically:
 *
 *   - stored subject matches an existing subject definition -> write the tag
 *   - stored subject has no definition yet -> create one (name, colour, kind) and
 *     write the tag
 *
 * No model calls. Idempotent. Scoped to the channels listed below unless
 * --channels is given. Videos with no stored subject are left alone; the model
 * found nothing nameable in them and that is a separate decision.
 *
 * Usage:
 *   node scripts/backfill-topic-tags.js                      # main repo defaults, writes in place
 *   node scripts/backfill-topic-tags.js --dry                # report only
 *   node scripts/backfill-topic-tags.js --tags F --topics F --data F [--channels id,id]
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
const CHANNELS = opt('--channels', 'UCfwE_ODI1YTbdjkzuSi1Nag,UCEOtZuVe8emWLKRzJIkzVow').split(',').map(s => s.trim()).filter(Boolean); // TheQuartering, JeremyHambly

const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const llm = read(TAGS);
const topics = read(TOPICS);
const data = read(DATA);
const tags = llm.tags || (llm.tags = {});
const modes = llm.modes || {};
const raw = llm._subjectRaw || {};

const ALIASES = opt('--aliases', path.join(ROOT, 'public', 'topic-aliases.json'));
// Spelling variants resolve to the subject we already have (see merge-topic-aliases.js),
// so "Cornell Seven" joins "Cornell 7 case" instead of becoming a second id.
const { slugify, keyOf, buildCanonMap, resolveSubjectId, loadAliases } = require('./merge-topic-aliases.js');
// Deterministic hue from the name, in the same spirit as the tagger's palette.
const colorOf = name => { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; const hue = h % 360; const [r, g, b] = hslToRgb(hue / 360, 0.6, 0.56); return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join(''); };
function hslToRgb(h, s, l) { const f = n => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); }; return [f(0), f(8), f(4)]; }
const usable = r => { if (r == null) return false; const s = String(r).trim(); return s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'none' && s.length <= 80; };

const promoted = new Set(llm._promotedSubjects || llm._promoted || []);
const { canon, groups } = buildCanonMap({ topics, tags, promoted, aliases: loadAliases(ALIASES) });
let joined = 0, created = 0, skipped = 0, folded = 0; const createdNames = [];
for (const v of data.videos || []) {
  if (!CHANNELS.includes(v.channelId) || v.isShort || v.unavailable) continue;
  if (tags[v.id] || !(v.id in modes) || !usable(raw[v.id])) continue;
  const name = String(raw[v.id]).trim();
  let id = resolveSubjectId(name, topics, canon, groups);
  if (id === null) {
    id = slugify(name);
    if (!id) { skipped++; continue; }
    const def = topics[id];
    if (def && def.kind && def.kind !== 'subject') { skipped++; continue; } // a theme or mode id collides; leave it
    if (!def) {
      if (!DRY) topics[id] = { name, color: colorOf(name), kind: 'subject' };
      // Register it so a variant spelling later in this same run joins it rather than creating another.
      const k = keyOf(name); if (k) (groups.get(k) || groups.set(k, []).get(k)).push(id); if (DRY) topics[id] = { name, kind: 'subject', _dry: true };
      created++; createdNames.push(name);
    }
  } else if (id !== slugify(name)) folded++;
  if (!DRY) tags[v.id] = id;
  joined++;
}

console.log(`backfill-topic-tags: ${joined} video${joined === 1 ? '' : 's'} joined to their subject (${joined - created} to existing topics, ${created} new one-off topics${folded ? `, ${folded} folded into an existing spelling` : ''})${skipped ? `, ${skipped} skipped` : ''}${DRY ? ' (dry run, nothing written)' : ''}`);
if (createdNames.length) console.log('  new topics e.g. ' + createdNames.slice(0, 12).join(', ') + (createdNames.length > 12 ? ', ...' : ''));
if (!DRY && joined) {
  fs.writeFileSync(TAGS, JSON.stringify(llm));
  if (created) fs.writeFileSync(TOPICS, JSON.stringify(topics));
}

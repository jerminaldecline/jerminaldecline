/**
 * Hourly debut sampler.
 *
 * The snapshot archive is twice-daily, which is fine for month-scale questions
 * but far too coarse for a video's first day — where nearly all of its views
 * arrive. The hourly `update-data` run already fetches every view count and then
 * discards 22 of the 24 readings, so this costs no extra YouTube API quota: it
 * just keeps the part that was being thrown away.
 *
 * Writes ONE small file per run rather than appending to a rolling one. Appending
 * rewrites the whole blob every hour, and git would store ~720 increasingly large
 * copies a month; one file per run stores each reading exactly once.
 *
 * Usage:
 *   node scripts/sample-debut.js --out /tmp/snapshots/debut [--hours 24] [--dry-run]
 *
 * Output: debut/YYYY-MM-DD-HH.json.gz
 *   { t, generatedFrom, hours, videos: [{ id, channelId, publishedAt, ageH,
 *                                          views, likes, comments }] }
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const arg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const OUT = arg('--out', null);
const HOURS = +arg('--hours', 24);
const DRY = args.includes('--dry-run');
const DATA = arg('--data', path.join(__dirname, '..', 'public', 'data.json'));

if (!OUT && !DRY) { console.error('--out <dir> is required (or use --dry-run)'); process.exit(1); }

let data;
try { data = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
catch (e) { console.error('cannot read ' + DATA + ': ' + e.message); process.exit(1); }

const now = new Date();
const cutoffMs = now.getTime() - HOURS * 3600 * 1000;

const videos = [];
for (const v of (data.videos || [])) {
  if (!v || !v.publishedAt) continue;
  const t = Date.parse(v.publishedAt);
  // Guard against a clock/timezone surprise putting a future video in the set.
  if (!Number.isFinite(t) || t > now.getTime() + 3600 * 1000) continue;
  if (t < cutoffMs) continue;
  videos.push({
    id: v.id,
    channelId: v.channelId,
    publishedAt: v.publishedAt,
    ageH: +((now.getTime() - t) / 3600000).toFixed(2),
    views: v.views || 0,
    likes: v.likes || 0,
    comments: v.comments || 0,
    isShort: !!v.isShort,
  });
}
videos.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));

const stamp = now.toISOString().slice(0, 13).replace('T', '-');   // YYYY-MM-DD-HH
const doc = {
  t: now.toISOString(),
  generatedFrom: path.basename(DATA),
  hours: HOURS,
  count: videos.length,
  videos,
};
const json = JSON.stringify(doc);
const gz = zlib.gzipSync(json, { level: 9 });

console.log(`debut sample ${stamp}: ${videos.length} videos under ${HOURS}h  (${json.length}B raw, ${gz.length}B gz)`);
if (videos.length) {
  const a = videos[videos.length - 1];
  console.log(`  newest: ${a.id} ${a.ageH}h old, ${a.views.toLocaleString()} views`);
}

// An empty sample is legitimate (a quiet night), but it should be visible rather
// than looking like a silent failure.
if (!videos.length) console.warn('  note: no uploads in the window — writing an empty sample');

if (DRY) { console.log('[dry-run] nothing written'); process.exit(0); }

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, stamp + '.json.gz');
if (fs.existsSync(file)) { console.log('  ' + path.basename(file) + ' already exists — leaving it alone'); process.exit(0); }
fs.writeFileSync(file, gz);
console.log('  wrote ' + file);

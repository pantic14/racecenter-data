// Injects the REST extras (trace + checkpoints) into a recording that was made without
// them — zero dependencies, node >= 20.
//
// The live recorder embeds a stage's altimetry (trace.json) and checkpoints, but only
// since 2026-07-15; anything recorded by an older recorder replays with no altitude (so no
// windowed VAM), no climbs and no weather. Both are static per stage and still served long
// after the stage, so they can be filled in afterwards.
//
// WEATHER: each checkpoint carries the weather at its own spot. ASO refreshes it every
// 30 min for the points still AHEAD of the race and leaves it alone once the race is past,
// so a checkpoint fetched AFTER the stage holds what it was like when the riders came
// through. Running this before a stage finishes would instead bake the pre-stage forecast —
// don't. (The finish is the exception: never "passed", it keeps refreshing until ASO stops
// hours later, so its reading is late. Its own meteoAt gives it away.)
//
// Usage:
//   node backfill-rest.mjs --date 2026-07-15      # one recording
//   node backfill-rest.mjs --all                  # every recording missing either
//   node backfill-rest.mjs --date X --force       # re-fetch even if already present
//
// Only rest.trace / rest.checkpoints are touched — the recorded events are never read,
// rewritten or reordered.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE, fetchTrace, fetchCheckpoints, writeRecording, upsertIndex } from './shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDINGS = path.join(HERE, 'recordings');
const INDEX = path.join(HERE, 'index.json');
const BASE = process.env.RC_BASE || DEFAULT_BASE;

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** @param {string} date */
function read(date) {
  const file = path.join(RECORDINGS, `${date}.json.gz`);
  if (!fs.existsSync(file)) throw new Error(`no recording at ${file}`);
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
}

/**
 * The stage number, which the bucket and the checkpoint endpoint are keyed by. Recordings
 * carry the whole season in rest.stages keyed by date, so this is a lookup, not a guess.
 */
function stageOf(rec, date) {
  const s = rec?.rest?.stages?.[date];
  if (s?.stage == null) throw new Error(`rest.stages['${date}'].stage missing — cannot tell which stage this is`);
  return { number: Number(s.stage), year: Number(date.slice(0, 4)) };
}

/** @param {string} date @param {boolean} force */
async function backfillOne(date, force) {
  const rec = read(date);
  const { number, year } = stageOf(rec, date);
  const has = { trace: !!rec.rest.trace, checkpoints: !!rec.rest.checkpoints };
  if (!force && has.trace && has.checkpoints) {
    console.error(`[backfill] ${date} (stage ${number}) — trace + checkpoints already present, skip`);
    return false;
  }

  let changed = false;
  if (force || !has.trace) {
    try {
      rec.rest.trace = await fetchTrace(year, number);
      console.error(`[backfill] ${date} — trace: ${rec.rest.trace.routePoints?.length ?? 0} points`);
      changed = true;
    } catch (e) {
      console.error(`[backfill] ${date} — trace FAILED (${e.message})`);
    }
  }
  if (force || !has.checkpoints) {
    try {
      rec.rest.checkpoints = await fetchCheckpoints(year, number, BASE);
      const map = Array.isArray(rec.rest.checkpoints) ? rec.rest.checkpoints[0] : rec.rest.checkpoints;
      const withMeteo = Object.keys(map ?? {}).filter((k) => /^\d+$/.test(k) && map[k].checkpointMeteo).length;
      console.error(`[backfill] ${date} — checkpoints: ${withMeteo} point(s) carrying weather`);
      changed = true;
    } catch (e) {
      console.error(`[backfill] ${date} — checkpoints FAILED (${e.message})`);
    }
  }
  if (!changed) return false;

  // Rewriting the .gz changes its size, and the extension streams recordings against the
  // byte count in the index — so the entry has to be refreshed. Everything else in it
  // (name, km, ticks, t0, t1, source…) describes the recording itself and must survive
  // untouched, hence the spread rather than a rebuilt entry.
  const { bytes } = writeRecording(RECORDINGS, date, rec);
  const index = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const entry = index.find((e) => e.id === date);
  if (!entry) throw new Error(`${date} has no index.json entry — refusing to invent one`);
  upsertIndex(INDEX, { ...entry, bytes });
  console.error(`[backfill] ${date} — rewrote recording (${(bytes / 1e6).toFixed(1)} MB) and index entry`);
  return true;
}

async function main() {
  const force = args.includes('--force');
  const date = opt('--date');
  /** @type {string[]} */
  let dates;
  if (date) dates = [date];
  else if (args.includes('--all')) dates = fs.readdirSync(RECORDINGS).filter((f) => f.endsWith('.json.gz')).map((f) => f.replace('.json.gz', '')).sort();
  else {
    console.error('usage: node backfill-rest.mjs (--date YYYY-MM-DD | --all) [--force]');
    process.exit(2);
  }

  let done = 0;
  for (const d of dates) {
    try {
      if (await backfillOne(d, force)) done++;
    } catch (e) {
      console.error(`[backfill] ${d} — ERROR: ${e.message}`);
    }
  }
  console.error(`[backfill] done — ${done} recording(s) updated`);
}

main().catch((e) => {
  console.error(`[backfill] fatal: ${e.stack || e.message}`);
  process.exit(1);
});

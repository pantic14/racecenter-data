// Shared helpers for the stage recorders — used by both recorder.mjs (live SSE
// firehose) and import-official.mjs (post-stage official static files). Zero deps,
// node >= 20. Both produce the exact same self-contained recording format
// (recordings/<date>.json.gz + upserted index.json) so the extension replays either
// with no code changes.

import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const DEFAULT_BASE = 'https://racecenter.letour.fr';

// ASO's public asset bucket (the one dansmacourse.letour.fr reads). The hash is an ASO
// build env var — undocumented, and it may rotate per season.
export const BUCKET_BASE = process.env.RC_BUCKET_BASE || 'https://storage.googleapis.com/tdf-prod-assets-7d6b412378cb7194';
export const RACE = process.env.RC_RACE || 'tdf';

export function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && v != null && v !== '' ? n : def;
}

/** Race-local "today" (yyyy-mm-dd). Stages run in CEST and finish before ~18:00, so UTC+2 is safe all day. */
export function raceDate(now = new Date()) {
  return new Date(now.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Fetch JSON via the built-in fetch (only the long-lived SSE breaks Node's parser, not these). */
export async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** URL of a stage's official route trace (altimetry + points of interest). */
export function traceUrl(year, stage) {
  return `${BUCKET_BASE}/${RACE}/${year}/stage-${stage}/trace.json`;
}

/**
 * A stage's official altimetry, embedded in the recording as `rest.trace` by BOTH
 * recorders. Without it a replay has no altitude source at all: the live SSE never sends
 * `mAlt` (verified 0/409881 riders on 2026-07-12), and the bucket drops old seasons, so
 * fetching it at replay time would rot. ~60-80 kB raw, a rounding error inside a
 * multi-megabyte recording. Best-effort — callers treat a failure as "no altitude".
 */
export async function fetchTrace(year, stage) {
  return getJson(traceUrl(year, stage));
}

/**
 * A stage's checkpoints: ASO's points of interest along the route, carrying the
 * categorised climbs (name, length, gradient, category) and per-point weather. Embedded in
 * the recording as `rest.checkpoints` because the endpoint is per-season — it will not
 * answer for 2026 once the season rolls over.
 */
export async function fetchCheckpoints(year, stage, base = DEFAULT_BASE) {
  return getJson(`${base}/api/checkpoint-${year}-${stage}`);
}

/**
 * One-time REST snapshot embedded in the recording so it stays self-contained —
 * names/teams/stages stay correct even if the stage is replayed years later.
 */
export async function fetchRest(year, base = DEFAULT_BASE) {
  const [riders, teams, stageList] = await Promise.all([
    getJson(`${base}/api/allCompetitors-${year}`),
    getJson(`${base}/api/team-${year}`).catch(() => []),
    getJson(`${base}/api/stage-${year}`),
  ]);
  /** @type {Record<string, any>} */
  const stages = {};
  for (const s of stageList) {
    const d = String(s.date).slice(0, 10);
    s.name = `Stage ${s.stage} - ${s.arrivalCity?.label ?? ''}`;
    stages[d] = s;
  }
  return { riders, teams, stages };
}

/**
 * Gzip (level 9) a recording and write it to <recordingsDir>/<date>.json.gz.
 * Returns the byte size so the caller can record it in the index entry.
 */
export function writeRecording(recordingsDir, date, recording) {
  const gz = gzipSync(Buffer.from(JSON.stringify(recording)), { level: 9 });
  fs.mkdirSync(recordingsDir, { recursive: true });
  fs.writeFileSync(path.join(recordingsDir, `${date}.json.gz`), gz);
  return { bytes: gz.length };
}

/** Read index.json (array), replace/insert the entry by id, keep it sorted by date. */
export function upsertIndex(file, entry) {
  /** @type {any[]} */
  let index = [];
  try {
    index = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(index)) index = [];
  } catch {
    index = [];
  }
  index = index.filter((e) => e.id !== entry.id);
  index.push(entry);
  index.sort((a, b) => (a.date < b.date ? -1 : 1));
  fs.writeFileSync(file, JSON.stringify(index, null, 2) + '\n');
}

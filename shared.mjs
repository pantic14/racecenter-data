// Shared helpers for the stage recorders — used by both recorder.mjs (live SSE
// firehose) and import-official.mjs (post-stage official static files). Zero deps,
// node >= 20. Both produce the exact same self-contained recording format
// (recordings/<date>.json.gz + upserted index.json) so the extension replays either
// with no code changes.

import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

export const DEFAULT_BASE = 'https://racecenter.letour.fr';

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

// Official post-stage replay importer — zero dependencies, node >= 20.
//
// ASO publishes the full replay of each finished stage as STATIC files in a public
// GCS bucket (the same source dansmacourse.letour.fr uses): one positions.csv per
// rider with a ~6s-cadence position timeline for the whole stage. This is far more
// reliable than scraping the live SSE firehose for 5h in CI (recorder.mjs), so it is
// the PRIMARY replay source; the live recorder stays as a fallback.
//
// This script downloads those CSVs and converts them into the exact same
// self-contained recording format recorder.mjs produces (recordings/<date>.json.gz +
// upserted index.json) — reconstructing telemetry frames with the site's capitalized
// field names so the extension replays them with zero code changes.
//
// The bucket is purged per season (last year's paths 404), so stages must be imported
// soon after they finish. `--backfill` handles both the initial catch-up and picking
// up each new finished stage on later runs (idempotent).
//
// Usage:
//   node import-official.mjs --stage 6
//   node import-official.mjs --date 2026-07-09
//   node import-official.mjs --backfill          # all finished stages not yet imported
// Env: RC_YEAR, RC_RACE, RC_BUCKET_BASE, RC_BASE, RC_CONCURRENCY, RC_MIN_TICKS

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE, num, raceDate, fetchRest, writeRecording, upsertIndex } from './shared.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.join(HERE, 'index.json');

const BUCKET = process.env.RC_BUCKET_BASE || 'https://storage.googleapis.com/tdf-prod-assets-7d6b412378cb7194';
const RACE = process.env.RC_RACE || 'tdf';
const REST_BASE = process.env.RC_BASE || DEFAULT_BASE;
const YEAR = num(process.env.RC_YEAR, new Date().getUTCFullYear());
const CONCURRENCY = num(process.env.RC_CONCURRENCY, 8);
const MIN_TICKS = num(process.env.RC_MIN_TICKS, 100);

// Each rider transmits on a ~6s grid; bin samples into 6s frames to reconstruct the
// live "one frame with all active riders" shape.
const BUCKET_MS = 6000;
const TELEMETRY_BIND = (year) => `telemetryCompetitor-${year}`;

const stagePath = (year, stage) => `${BUCKET}/${RACE}/${year}/stage-${stage}`;
const ridersManifestUrl = (year, stage) => `${stagePath(year, stage)}/riders/manifest.json`;
const positionsUrl = (year, stage, bib) => `${stagePath(year, stage)}/riders/bib-${bib}/positions.csv`;
const traceUrl = (year, stage) => `${stagePath(year, stage)}/trace.json`;
const stagesUrl = (year) => `${BUCKET}/${RACE}/${year}/stages_${RACE}_${year}.json`;

// Half-window (metres) over which the road gradient is measured, to smooth GPS noise.
// Kept above the trace's ~108 m point spacing so the window spans real neighbours.
const GRADIENT_WINDOW_M = 150;

/** Great-circle distance between two lat/lon points, in metres. */
function haversineM(aLat, aLon, bLat, bLon) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Build an interpolator over a stage's route trace ({routePoints:[{lat,lon,ele}],
 * totalDistance}) so a rider's altitude and road gradient can be looked up from its
 * kmToFinish. positions.csv carries neither, but trace.json has the elevation profile
 * (kmToFinish lines up with totalDistance), and gradient is the local slope of it.
 * @returns {{ totalKm:number, lookup:(kmToFinish:number)=>{ele:number, grad:number} } | null}
 */
export function buildTraceIndex(trace) {
  const pts = trace?.routePoints;
  if (!Array.isArray(pts) || pts.length < 2) return null;
  const n = pts.length;
  const dist = new Float64Array(n); // metres from start, ascending
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  const totalM = dist[n - 1];
  if (!(totalM > 0)) return null;
  const totalKm = Number(trace.totalDistance) > 0 ? Number(trace.totalDistance) : totalM / 1000;

  // Gradient (%) at each point: rise over run in the direction of travel, measured
  // across a ±window so a single noisy elevation sample can't spike it.
  const grad = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let lo = i;
    let hi = i;
    while (lo > 0 && dist[i] - dist[lo] < GRADIENT_WINDOW_M) lo--;
    while (hi < n - 1 && dist[hi] - dist[i] < GRADIENT_WINDOW_M) hi++;
    // Ensure the window spans at least the immediate neighbours (point spacing can
    // exceed the window), otherwise run would be 0 and the gradient always flat.
    if (lo === i && i > 0) lo = i - 1;
    if (hi === i && i < n - 1) hi = i + 1;
    const run = dist[hi] - dist[lo];
    grad[i] = run > 1 ? ((pts[hi].ele - pts[lo].ele) / run) * 100 : 0;
  }

  /** Linear interpolation of ele + grad at a distance-from-start (metres). */
  function at(distM) {
    if (distM <= 0) return { ele: pts[0].ele, grad: grad[0] };
    if (distM >= totalM) return { ele: pts[n - 1].ele, grad: grad[n - 1] };
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] <= distM) lo = mid;
      else hi = mid;
    }
    const span = dist[hi] - dist[lo] || 1;
    const t = (distM - dist[lo]) / span;
    return { ele: pts[lo].ele + t * (pts[hi].ele - pts[lo].ele), grad: grad[lo] + t * (grad[hi] - grad[lo]) };
  }

  return {
    totalKm,
    lookup(kmToFinish) {
      const frac = 1 - Math.min(Math.max(kmToFinish / totalKm, 0), 1); // 0 at start → 1 at finish
      return at(frac * totalM);
    },
  };
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

async function statusOf(url) {
  const res = await fetch(url, { method: 'HEAD' });
  res.body?.cancel?.();
  return res.status;
}

/**
 * Parse a rider positions.csv (column order read from the header, so it is robust to
 * reordering). Rows come newest-first; we keep them as-is here and order by timestamp
 * later. Empty cells become null (so the reconstructed frame omits the field).
 * @returns {{bib:number, lat:number|null, lon:number|null, kph:number|null, kmToFinish:number|null, secToFirstRider:number|null, tsMs:number}[]}
 */
export function parseCsv(text) {
  const lines = text.split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const samples = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = line.split(',');
    const tsMs = Date.parse(f[col.timestamp]);
    if (!Number.isFinite(tsMs)) continue;
    const cell = (name) => {
      const v = f[col[name]];
      return v == null || v === '' ? null : Number(v);
    };
    samples.push({
      bib: Number(f[col.bib]),
      lat: cell('lat'),
      lon: cell('lon'),
      kph: cell('kph'),
      kmToFinish: cell('kmToFinish'),
      secToFirstRider: cell('secToFirstRider'),
      tsMs,
    });
  }
  return samples;
}

/**
 * Convert per-bib CSV samples into `{dt, data}` telemetry events matching the live SSE
 * shape. Bins all samples onto a shared 6s grid; each bin becomes one frame carrying
 * the nearest-to-center sample of every rider present. `dt` is the ms gap to the
 * previous frame (0 on the first). Field names are the site's capitalized ones so
 * `normalizeTelemetry` picks them up; absent fields are omitted (→ null/NaN).
 * If a traceIndex is given, each rider also gets `mAlt` (altitude) and `Gradient`
 * looked up from its kmToFinish, so the altitude/road-grade overlays work in the
 * official replay too (positions.csv itself carries neither).
 * @param {Record<string|number, ReturnType<typeof parseCsv>>} samplesByBib
 * @param {number} year
 * @param {ReturnType<typeof buildTraceIndex>} [traceIndex]
 * @returns {{dt:number, data:string}[]}
 */
export function buildEvents(samplesByBib, year, traceIndex = null) {
  /** @type {Map<number, Map<number, {sample:any, dist:number}>>} bucket -> bib -> best sample */
  const buckets = new Map();
  for (const samples of Object.values(samplesByBib)) {
    for (const s of samples) {
      const b = Math.round(s.tsMs / BUCKET_MS);
      let byBib = buckets.get(b);
      if (!byBib) buckets.set(b, (byBib = new Map()));
      const dist = Math.abs(s.tsMs - b * BUCKET_MS);
      const prev = byBib.get(s.bib);
      if (!prev || dist < prev.dist) byBib.set(s.bib, { sample: s, dist });
    }
  }

  const bind = TELEMETRY_BIND(year);
  const sortedBuckets = [...buckets.keys()].sort((a, b) => a - b);
  const events = [];
  let prevB = null;
  for (const b of sortedBuckets) {
    const Riders = [];
    for (const { sample: s } of buckets.get(b).values()) {
      const r = { Bib: s.bib };
      if (s.lat != null) r.Latitude = s.lat;
      if (s.lon != null) r.Longitude = s.lon;
      if (s.kph != null) r.kph = s.kph;
      if (s.kmToFinish != null) r.kmToFinish = s.kmToFinish;
      if (s.secToFirstRider != null) r.secToFirstRider = s.secToFirstRider;
      if (traceIndex && s.kmToFinish != null) {
        const { ele, grad } = traceIndex.lookup(s.kmToFinish);
        r.mAlt = Math.round(ele);
        r.Gradient = Math.round(grad * 10) / 10;
      }
      Riders.push(r);
    }
    const TimeStamp = b * (BUCKET_MS / 1000); // unix seconds
    const data = JSON.stringify({ bind, data: { TimeStamp, Riders } });
    events.push({ dt: prevB == null ? 0 : (b - prevB) * BUCKET_MS, data });
    prevB = b;
  }
  return events;
}

function readIndex() {
  try {
    const idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return Array.isArray(idx) ? idx : [];
  } catch {
    return [];
  }
}

/** Run `worker` over `items` with at most `size` concurrent calls. */
async function pool(items, size, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

/** Download every rider's positions.csv for a stage and build the recording events. */
async function importStage(stage, date) {
  const year = Number(date.slice(0, 4));
  console.error(`[import] stage ${stage} (${date}) — fetching riders manifest…`);
  const manifest = await getJson(ridersManifestUrl(year, stage));
  const bibs = Object.keys(manifest)
    .map((k) => Number(k.replace('bib-', '')))
    .filter((n) => Number.isFinite(n));
  console.error(`[import] ${bibs.length} riders — downloading positions.csv (${CONCURRENCY} in parallel)…`);

  const samplesByBib = {};
  let done = 0;
  await pool(bibs, CONCURRENCY, async (bib) => {
    try {
      const csv = await getText(positionsUrl(year, stage, bib));
      const samples = parseCsv(csv);
      if (samples.length) samplesByBib[bib] = samples;
    } catch (e) {
      console.error(`[import] bib-${bib}: ${e.message}`);
    }
    if (++done % 50 === 0) console.error(`[import] ${done}/${bibs.length} riders…`);
  });

  // Route trace gives the altitude profile; enrich riders with altitude + gradient
  // (positions.csv has neither). Best-effort: a missing trace just leaves them absent.
  let traceIndex = null;
  try {
    const trace = await getJson(traceUrl(year, stage));
    traceIndex = buildTraceIndex(trace);
    console.error(`[import] trace: ${trace.routePoints?.length ?? 0} points — enriching altitude + gradient`);
  } catch (e) {
    console.error(`[import] no usable trace (${e.message}) — altitude/gradient absent`);
  }

  const events = buildEvents(samplesByBib, year, traceIndex);
  if (events.length < MIN_TICKS) {
    throw new Error(`only ${events.length} frames (< ${MIN_TICKS}) — stage not ready or no data, nothing written`);
  }

  console.error(`[import] snapshotting REST…`);
  const rest = await fetchRest(year, REST_BASE);
  const currentStage = rest.stages[date] || null;
  const t0 = JSON.parse(events[0].data).data.TimeStamp;
  const t1 = JSON.parse(events[events.length - 1].data).data.TimeStamp;

  const recording = {
    version: 1,
    meta: { date, year, recordedAt: new Date().toISOString(), source: 'official' },
    rest,
    events,
  };
  const rel = `recordings/${date}.json.gz`;
  const { bytes } = writeRecording(path.join(HERE, 'recordings'), date, recording);
  upsertIndex(INDEX_FILE, {
    id: date,
    date,
    name: currentStage?.name ?? '',
    km: currentStage?.length ?? null,
    ticks: events.length,
    t0,
    t1,
    bytes,
    file: rel,
    source: 'official',
  });
  console.error(`[import] wrote ${rel} (${(bytes / 1e6).toFixed(1)} MB, ${events.length} frames, ${Object.keys(samplesByBib).length} riders)`);
}

/** Season stage list from the bucket: [{stage, date, ...}]. */
async function fetchStages(year) {
  return getJson(stagesUrl(year));
}

/**
 * Import every finished stage (date < today) whose bucket data exists and that isn't
 * already imported from the official source. Overwrites live-recorder entries once
 * (official is primary), then skips them on later runs — idempotent, and picks up each
 * newly finished stage automatically.
 */
async function backfill(year) {
  const stages = await fetchStages(year);
  const today = raceDate();
  const byId = new Map(readIndex().map((e) => [e.id, e]));
  let imported = 0;
  for (const s of stages) {
    const date = String(s.date).slice(0, 10);
    if (!(date < today)) continue; // stage not finished yet
    const existing = byId.get(date);
    if (existing?.source === 'official') {
      console.error(`[import] ${date} (stage ${s.stage}) — already imported, skip`);
      continue;
    }
    const status = await statusOf(ridersManifestUrl(year, s.stage)).catch(() => 0);
    if (status !== 200) {
      console.error(`[import] ${date} (stage ${s.stage}) — bucket data unavailable (HTTP ${status}), skip`);
      continue;
    }
    try {
      await importStage(s.stage, date);
      imported++;
    } catch (e) {
      console.error(`[import] ${date} (stage ${s.stage}) — ${e.message}`);
    }
  }
  console.error(`[import] backfill done — ${imported} stage(s) imported`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (args.includes('--backfill')) {
    await backfill(YEAR);
    return;
  }
  const dateArg = opt('--date');
  if (dateArg) {
    const year = Number(dateArg.slice(0, 4));
    const stages = await fetchStages(year);
    const match = stages.find((s) => String(s.date).slice(0, 10) === dateArg);
    if (!match) throw new Error(`no stage found for date ${dateArg}`);
    await importStage(match.stage, dateArg);
    return;
  }
  const stageArg = opt('--stage');
  if (stageArg) {
    const stage = Number(stageArg);
    const stages = await fetchStages(YEAR);
    const match = stages.find((s) => Number(s.stage) === stage);
    if (!match) throw new Error(`no stage ${stage} in ${YEAR} season list`);
    await importStage(stage, String(match.date).slice(0, 10));
    return;
  }
  console.error('usage: node import-official.mjs (--stage N | --date YYYY-MM-DD | --backfill)');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[import] fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}

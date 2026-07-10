// Racecenter stage recorder — zero dependencies, node >= 20.
//
// Connects to racecenter.letour.fr's /live-stream SSE firehose and records EVERY
// event ({dt, data}) verbatim, plus a one-time snapshot of the REST endpoints
// (riders/teams/stages) so the recording is self-contained forever — names and
// teams stay correct even if replayed years later. Output: recordings/<date>.json.gz
// and an upserted index.json manifest.
//
// Runs unattended from a GitHub Actions cron (see .github/workflows/record.yml) and
// also locally (`node recorder.mjs`) as a backup / for testing.
//
// NOTE: Node's HTTP parser rejects racecenter's SSE chunked encoding ("Invalid
// character in chunk size"), so we use https.get with insecureHTTPParser:true —
// the same fix the extension's Vite dev proxy uses. undici's fetch has no equivalent
// escape hatch, hence raw https.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.RC_BASE || 'https://racecenter.letour.fr';

// All tunables env-overridable so the out-of-hours local test can use short timers.
const HARD_TIMEOUT_MS = num(process.env.RC_MAX_MS, 5.5 * 3600 * 1000);
const SILENCE_MS = num(process.env.RC_SILENCE_MS, 30 * 60 * 1000);
const MIN_TICKS = num(process.env.RC_MIN_TICKS, 100);
const MONITOR_MS = num(process.env.RC_MONITOR_MS, 30 * 1000);

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && v != null && v !== '' ? n : def;
}

/** Race-local "today" (yyyy-mm-dd). Stages run in CEST and finish before ~18:00, so UTC+2 is safe all day. */
export function raceDate(now = new Date()) {
  return new Date(now.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Incremental SSE parser. Feed it arbitrary chunks; it calls onEvent({event, data})
 * once per complete event (blank-line separated). Handles \r\n, multi-line data,
 * and colon-less field lines per the SSE spec; ignores comments (":") and id/retry.
 * Chunk-boundary safe: only whole lines (up to \n) are consumed, the rest is buffered.
 * @param {(ev: {event: string, data: string}) => void} onEvent
 */
export function createSSEParser(onEvent) {
  let buf = '';
  let eventType = 'message';
  /** @type {string[]} */
  let dataLines = [];

  return function feed(chunk) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        if (dataLines.length) onEvent({ event: eventType, data: dataLines.join('\n') });
        eventType = 'message';
        dataLines = [];
        continue;
      }
      if (line[0] === ':') continue; // comment / keep-alive

      const colon = line.indexOf(':');
      let field, value;
      if (colon === -1) {
        field = line;
        value = '';
      } else {
        field = line.slice(0, colon);
        value = line.slice(colon + 1);
        if (value[0] === ' ') value = value.slice(1);
      }
      if (field === 'event') eventType = value;
      else if (field === 'data') dataLines.push(value);
    }
  };
}

/** Fetch JSON via the built-in fetch (only the long-lived SSE breaks Node's parser, not these). */
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** One-time REST snapshot embedded in the recording so it stays self-contained. */
async function fetchRest(year, date) {
  const [riders, teams, stageList] = await Promise.all([
    getJson(`${BASE}/api/allCompetitors-${year}`),
    getJson(`${BASE}/api/team-${year}`).catch(() => []),
    getJson(`${BASE}/api/stage-${year}`),
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
 * Open one SSE connection and pipe its body to `feed`. Resolves when the server
 * closes the stream (normal end of stage), rejects on transport / non-200 errors.
 * Registers the request via onReq so the caller can abort it when finishing.
 */
function streamOnce(url, feed, onReq) {
  return new Promise((resolve, reject) => {
    // insecureHTTPParser only takes effect when passed inside an explicit options
    // object (a string URL + options does NOT merge it in — verified on node 24).
    const u = new URL(url);
    const req = https.get(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        insecureHTTPParser: true,
        headers: { Accept: 'text/event-stream', 'User-Agent': 'racecenter-recorder' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        console.error(`[recorder] connected (HTTP 200)`);
        res.setEncoding('utf8');
        res.on('data', feed);
        res.on('end', resolve);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    onReq(req);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const date = process.env.RC_DATE || raceDate();
  const year = Number(date.slice(0, 4));
  const bind = `telemetryCompetitor-${year}`;

  console.error(`[recorder] ${date} — snapshotting REST…`);
  const rest = await fetchRest(year, date);
  const currentStage = rest.stages[date] || null;
  console.error(`[recorder] stage: ${currentStage?.name ?? '(unknown)'} — waiting for telemetry`);

  /** @type {{dt: number, data: string}[]} */
  const events = [];
  let telemetryCount = 0;
  let t0 = null;
  let t1 = null;
  let lastRecordAt = null; // wall clock of previous recorded event (for dt)
  let lastEventAt = Date.now(); // any event; drives the silence timer
  let stopping = false;
  let currentReq = null;

  function handleEvent(ev) {
    const now = Date.now();
    lastEventAt = now; // ANY event (telemetry or not) keeps the silence timer alive

    if (ev.event !== 'update') return;
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    // Keep ONLY non-empty telemetry frames. The firehose also carries socialContent,
    // video, image and ranking binds that the replay discards anyway — storing them
    // all bloated recordings ~100x (137 MB for one stage) and blew JSON.stringify past
    // V8's ~512 MB string limit on busy stages. Empty-Riders frames (the site emits
    // them frozen before/after a stage) are skipped too, so a post-stage-only run
    // stays under MIN_TICKS and is discarded instead of saved as a useless recording.
    // `dt` is the gap since the previous KEPT event so replay timing stays faithful.
    if (d.bind !== bind || !Array.isArray(d.data?.Riders) || d.data.Riders.length === 0) return;
    events.push({ dt: lastRecordAt == null ? 0 : now - lastRecordAt, data: ev.data });
    lastRecordAt = now;

    telemetryCount++;
    const ts = Number(d.data.TimeStamp);
    if (ts) {
      if (t0 == null) t0 = ts;
      t1 = ts;
    }
    if (telemetryCount % 300 === 0) console.error(`[recorder] ${telemetryCount} ticks…`);
  }

  const startedAt = Date.now();
  function finish(reason) {
    if (stopping) return;
    stopping = true;
    clearInterval(monitor);
    currentReq?.destroy();
    write(reason);
  }

  const monitor = setInterval(() => {
    if (Date.now() - startedAt > HARD_TIMEOUT_MS) finish('hard-timeout');
    else if (Date.now() - lastEventAt > SILENCE_MS) finish('silence');
  }, MONITOR_MS);

  function write(reason) {
    console.error(`[recorder] stop (${reason}): ${events.length} events, ${telemetryCount} telemetry ticks`);
    if (telemetryCount < MIN_TICKS) {
      console.error(`[recorder] < ${MIN_TICKS} ticks — rest day / no stage, nothing saved`);
      process.exit(0);
    }
    const recording = {
      version: 1,
      meta: { date, year, recordedAt: new Date().toISOString() },
      rest,
      events,
    };
    const gz = gzipSync(Buffer.from(JSON.stringify(recording)), { level: 9 });
    const dir = path.join(HERE, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const rel = `recordings/${date}.json.gz`;
    fs.writeFileSync(path.join(HERE, rel), gz);
    upsertIndex({
      id: date,
      date,
      name: currentStage?.name ?? '',
      km: currentStage?.length ?? null,
      ticks: telemetryCount,
      t0,
      t1,
      bytes: gz.length,
      file: rel,
    });
    console.error(`[recorder] wrote ${rel} (${(gz.length / 1e6).toFixed(1)} MB)`);
    process.exit(0);
  }

  // Reconnect with backoff; keep appending to the same recording across drops.
  // Fresh parser per connection so a mid-event drop can't leak a partial line
  // into the first event of the next stream.
  let backoff = 2_000;
  while (!stopping) {
    try {
      await streamOnce(BASE + '/live-stream', createSSEParser(handleEvent), (r) => (currentReq = r));
      backoff = 2_000; // clean server close → reconnect promptly
    } catch (e) {
      if (stopping) break;
      console.error(`[recorder] stream error: ${e.message} — retry in ${backoff}ms`);
    }
    if (stopping) break;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

/** Read index.json (array), replace/insert the entry by id, keep it sorted by date. */
function upsertIndex(entry) {
  const file = path.join(HERE, 'index.json');
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[recorder] fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}

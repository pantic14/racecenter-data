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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE, num, raceDate, fetchRest, fetchTrace, fetchCheckpoints, writeRecording, upsertIndex } from './shared.mjs';

// Re-exported so recorder.test.mjs can import it from here alongside createSSEParser.
export { raceDate };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.RC_BASE || DEFAULT_BASE;

// All tunables env-overridable so the out-of-hours local test can use short timers.
const HARD_TIMEOUT_MS = num(process.env.RC_MAX_MS, 5.5 * 3600 * 1000);
const SILENCE_MS = num(process.env.RC_SILENCE_MS, 30 * 60 * 1000);
const MIN_TICKS = num(process.env.RC_MIN_TICKS, 100);
const MONITOR_MS = num(process.env.RC_MONITOR_MS, 30 * 1000);

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

/**
 * Open one SSE connection and pipe its body to `feed`. Resolves when the server
 * closes the stream (normal end of stage), rejects on transport / non-200 errors.
 * Registers the request via onReq so the caller can abort it when finishing.
 *
 * One connection is NOT one stage: racecenter drops the stream every few minutes, so any
 * caller wanting a whole stage must wrap this in a reconnect loop (see main()).
 * @param {string} tag prefix for this caller's log lines and User-Agent
 */
export function streamOnce(url, feed, onReq, tag = 'recorder') {
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
        headers: { Accept: 'text/event-stream', 'User-Agent': `racecenter-${tag}` },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        console.error(`[${tag}] connected (HTTP 200)`);
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
  const rest = await fetchRest(year, BASE);
  const currentStage = rest.stages[date] || null;

  // The live SSE never sends altitude, so without the official trace a live recording can
  // never show altitude or windowed VAM on replay. Best-effort: no trace just means the
  // recording keeps the (still complete) telemetry, exactly as before.
  if (currentStage?.stage != null) {
    try {
      rest.trace = await fetchTrace(year, currentStage.stage);
      console.error(`[recorder] trace: ${rest.trace.routePoints?.length ?? 0} points embedded`);
    } catch (e) {
      console.error(`[recorder] no trace (${e.message}) — recording will have no altitude`);
    }
    try {
      rest.checkpoints = await fetchCheckpoints(year, currentStage.stage, BASE);
      console.error(`[recorder] checkpoints embedded`);
    } catch (e) {
      console.error(`[recorder] no checkpoints (${e.message}) — replay will have no climbs`);
    }
  }
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
    write(reason).catch((e) => {
      console.error(`[recorder] write failed: ${e.stack || e.message}`);
      process.exit(1);
    });
  }

  const monitor = setInterval(() => {
    if (Date.now() - startedAt > HARD_TIMEOUT_MS) finish('hard-timeout');
    else if (Date.now() - lastEventAt > SILENCE_MS) finish('silence');
  }, MONITOR_MS);

  async function write(reason) {
    console.error(`[recorder] stop (${reason}): ${events.length} events, ${telemetryCount} telemetry ticks`);
    if (telemetryCount < MIN_TICKS) {
      console.error(`[recorder] < ${MIN_TICKS} ticks — rest day / no stage, nothing saved`);
      process.exit(0);
    }

    // Re-read the checkpoints now the stage is over. Their climbs never move, but each one
    // also carries the weather at its own spot, refreshed every 30 min for the points still
    // AHEAD of the race and left alone once the race is past — so after the finish every
    // point holds what it was like when the riders came through, which is exactly what a
    // replay wants. The copy taken at startup is only the pre-stage forecast. Verified on
    // 2026-07-15: km 123.4 stayed at its 16:30 reading through the 17:00 refresh while the
    // finish kept updating. Best-effort: on failure the startup copy stands, as before.
    if (currentStage?.stage != null) {
      try {
        rest.checkpoints = await fetchCheckpoints(year, currentStage.stage, BASE);
        console.error('[recorder] checkpoints re-read after finish (weather as ridden)');
      } catch (e) {
        console.error(`[recorder] checkpoint re-read failed (${e.message}) — keeping the pre-stage copy`);
      }
    }

    const recording = {
      version: 1,
      meta: { date, year, recordedAt: new Date().toISOString() },
      rest,
      events,
    };
    const rel = `recordings/${date}.json.gz`;
    const { bytes } = writeRecording(path.join(HERE, 'recordings'), date, recording);
    upsertIndex(path.join(HERE, 'index.json'), {
      id: date,
      date,
      name: currentStage?.name ?? '',
      km: currentStage?.length ?? null,
      ticks: telemetryCount,
      t0,
      t1,
      bytes,
      file: rel,
    });
    console.error(`[recorder] wrote ${rel} (${(bytes / 1e6).toFixed(1)} MB)`);
    process.exit(0);
  }

  // Reconnect with backoff; keep appending to the same recording across drops.
  // Fresh parser per connection so a mid-event drop can't leak a partial line
  // into the first event of the next stream.
  let backoff = 2_000;
  while (!stopping) {
    try {
      await streamOnce(BASE + '/live-stream', createSSEParser(handleEvent), (r) => (currentReq = r), 'recorder');
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[recorder] fatal: ${e.stack || e.message}`);
    process.exit(1);
  });
}

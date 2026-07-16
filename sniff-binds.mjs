// Reconnaissance tool for the /live-stream firehose — zero dependencies, node >= 20.
//
// recorder.mjs keeps ONLY the telemetry bind, because storing the whole firehose bloated
// recordings ~100x and blew V8's string limit. That filter is right, but it means we have
// never stored a single event of any other bind and have no idea what they carry — we only
// ever saw the names go past: pack-*, telemetryPack-*, insights-*, checkpoint-*, video-*,
// socialContent-*, extraVehicle-*, fantasy-*.
//
// This connects, keeps a few SAMPLES of each bind (not the stream), and exits. Output is a
// few kB, nothing else changes. If something in here turns out to be worth having, THEN
// decide whether the recorder should keep it.
//
// Usage:
//   node sniff-binds.mjs                     # 5 minutes, writes sniff-<date>.json
//   node sniff-binds.mjs --minutes 20        # listen longer (catches rarer binds)
//   node sniff-binds.mjs --out /tmp/x.json
//
// Run it DURING a stage: outside race hours the stream stays open but silent, so an
// out-of-hours run tells you only that the connection works.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BASE, num } from './shared.mjs';
import { createSSEParser, streamOnce } from './recorder.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.RC_BASE || DEFAULT_BASE;

/**
 * Distinct payloads kept per bind. The slow binds are the ones worth diffing, and they
 * change a handful of times an hour — 5 covers a stage's worth of checkpoint updates.
 */
const SAMPLES_PER_BIND = 5;
/**
 * A sample is truncated past this, so one fat payload can't dominate the file. Generous
 * enough to hold a whole checkpoint frame (~27 kB), which is the interesting one.
 */
const MAX_SAMPLE_CHARS = num(process.env.RC_MAX_SAMPLE, 200000);

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * Group a bind into a family by stripping the season/stage suffix, so
 * `telemetryCompetitor-2026` and `checkpoint-2026-11` don't look like different things
 * every stage.
 */
function family(bind) {
  return String(bind).replace(/-\d{4}(-\d+)?$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

async function main() {
  const minutes = num(opt('--minutes'), 5);
  const out = opt('--out') || path.join(HERE, `sniff-${new Date().toISOString().slice(0, 10)}.json`);
  const url = `${BASE}/live-stream`;

  /** @type {Map<string, {bind: string, family: string, count: number, changes: number, changedAt: string[], firstAt: string, lastAt: string, samples: any[], bytes: number, _seen: Set<string>, _last: string}>} */
  const binds = new Map();
  let events = 0;
  let nonJson = 0;
  let reconnects = 0;
  /** @type {string[]} */
  const nonJsonSamples = [];

  /** One parsed SSE event. Wrapped in a fresh parser per connection by the loop below. */
  const feedEvent = (ev) => {
    events++;
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      // The firehose really does carry non-JSON data lines (bare UUIDs) — keep a couple so
      // we know what they are rather than silently counting them.
      nonJson++;
      if (nonJsonSamples.length < 5) nonJsonSamples.push(ev.data.slice(0, 200));
      return;
    }
    const bind = d?.bind ?? `(no bind, event: ${ev.event})`;
    let rec = binds.get(bind);
    if (!rec) {
      rec = { bind, family: family(bind), count: 0, changes: 0, changedAt: [], firstAt: new Date().toISOString(), lastAt: '', samples: [], bytes: 0, _seen: new Set(), _last: '' };
      binds.set(bind, rec);
      console.error(`[sniff] new bind: ${bind}`);
    }
    const now = new Date().toISOString();
    rec.count++;
    rec.lastAt = now;
    rec.bytes += ev.data.length;

    // Raw event counts can't answer "how often does this really change?": every reconnect
    // replays the current snapshot of every bind, so a bind that never changes still
    // arrives once per connection. Hashing the payload separates real updates from
    // re-sends — which is exactly the decision the recorder needs for checkpoint/weather.
    const h = hash(ev.data);
    let isNew = false;
    if (h !== rec._last) {
      rec._last = h;
      if (!rec._seen.has(h)) {
        rec._seen.add(h);
        rec.changes++;
        rec.changedAt.push(now);
        isNew = true;
      }
    }
    // Sample DISTINCT payloads, not the first N to arrive: with a reconnect every ~60 s,
    // the first N of a slow bind are all the same snapshot re-sent, which tells you what
    // the bind holds but not what moves in it. Consecutive distinct samples diff.
    if (isNew && rec.samples.length < SAMPLES_PER_BIND) {
      rec.samples.push(ev.data.length > MAX_SAMPLE_CHARS ? { _truncated: ev.data.length, head: ev.data.slice(0, MAX_SAMPLE_CHARS) } : d);
    }
  };

  console.error(`[sniff] ${url} — listening ${minutes} min (Ctrl+C to stop early and still write)`);

  const startedAt = new Date().toISOString();
  let req = null;
  let stopping = false;
  const write = (reason) => {
    if (stopping) return;
    stopping = true;
    req?.destroy();
    const list = [...binds.values()]
      .sort((a, b) => b.count - a.count)
      .map(({ _seen, _last, ...b }) => b); // internal dedup state, not worth writing out
    const mins = (Date.now() - Date.parse(startedAt)) / 60000;
    fs.writeFileSync(
      out,
      JSON.stringify({ url, startedAt, stoppedAt: new Date().toISOString(), minutes: +mins.toFixed(1), stoppedBecause: reason, events, reconnects, nonJson, nonJsonSamples, binds: list }, null, 2),
    );
    console.error(`\n[sniff] ${reason} — ${events} events, ${binds.size} distinct binds, ${reconnects} reconnects, ${mins.toFixed(1)} min`);
    console.error(`  ${'events'.padStart(6)} ${'changes'.padStart(7)}  ${'bind'.padEnd(30)} ${'total'.padStart(8)}`);
    for (const b of list) {
      console.error(`  ${String(b.count).padStart(6)} ${String(b.changes).padStart(7)}  ${b.bind.padEnd(30)} ${(b.bytes / 1024).toFixed(0).padStart(6)} kB`);
    }
    console.error(`[sniff] wrote ${out}`);
    process.exit(0);
  };

  setTimeout(() => write('time-up'), minutes * 60 * 1000);
  process.on('SIGINT', () => write('interrupted'));

  // racecenter drops the stream every few minutes ("Invalid character in chunk size"), so
  // a single connection samples about a minute of race, not the window asked for. Same
  // reconnect loop the recorder uses, with a fresh parser per connection so a mid-event
  // drop can't leak a partial line into the next stream's first event.
  let backoff = 2_000;
  while (!stopping) {
    try {
      await streamOnce(url, createSSEParser(feedEvent), (r) => (req = r), 'sniff');
      backoff = 2_000; // clean server close → reconnect promptly
    } catch (e) {
      if (stopping) break;
      console.error(`[sniff] stream error: ${e.message} — retry in ${backoff}ms`);
    }
    if (stopping) break;
    reconnects++;
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

main();

// node --test recorder.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createSSEParser, raceDate } from './recorder.mjs';

/** Feed a full SSE text to the parser split into chunks of `size` chars. */
function parseInChunks(text, size) {
  const out = [];
  const feed = createSSEParser((ev) => out.push(ev));
  for (let i = 0; i < text.length; i += size) feed(text.slice(i, i + size));
  return out;
}

const STREAM =
  ': keep-alive comment\n' +
  'event: update\n' +
  'data: {"bind":"telemetryCompetitor-2026","data":{"TimeStamp":1,"Riders":[{"Bib":1}]}}\n' +
  '\n' +
  'event: update\n' +
  'data: {"bind":"pack-2026-5"}\n' +
  '\n' +
  // multi-line data event (data lines joined by \n)
  'event: update\n' +
  'data: line one\n' +
  'data: line two\n' +
  '\n' +
  // CRLF line endings
  'event: update\r\n' +
  'data: {"bind":"video-1"}\r\n' +
  '\r\n';

test('parser reconstructs the same events regardless of chunk size', () => {
  const whole = parseInChunks(STREAM, STREAM.length);
  assert.equal(whole.length, 4);
  assert.equal(whole[0].event, 'update');
  assert.deepEqual(JSON.parse(whole[0].data).bind, 'telemetryCompetitor-2026');
  assert.equal(whole[2].data, 'line one\nline two');
  assert.equal(JSON.parse(whole[3].data).bind, 'video-1');

  // arbitrary chunk boundaries must not change the result
  for (const size of [1, 2, 3, 5, 7, 13, 50]) {
    assert.deepEqual(parseInChunks(STREAM, size), whole, `chunk size ${size}`);
  }
});

test('parser ignores comments and never emits an event without data', () => {
  const out = [];
  const feed = createSSEParser((ev) => out.push(ev));
  feed(': just a comment\n\n'); // comment then blank line
  feed('event: ping\n\n'); // event field but no data -> no emit
  assert.equal(out.length, 0);
});

test('parser buffers a partial final line until its newline arrives', () => {
  const out = [];
  const feed = createSSEParser((ev) => out.push(ev));
  feed('data: {"a":1}'); // no newline yet
  assert.equal(out.length, 0);
  feed('\n\n');
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0].data), { a: 1 });
});

test('gzip roundtrip of a recording preserves the events', () => {
  const recording = {
    version: 1,
    meta: { date: '2026-07-09', year: 2026, recordedAt: new Date().toISOString() },
    rest: { riders: [{ bib: 1 }], teams: [], stages: {} },
    events: [
      { dt: 0, data: '{"bind":"telemetryCompetitor-2026"}' },
      { dt: 1000, data: '{"bind":"pack-2026-5"}' },
    ],
  };
  const gz = gzipSync(Buffer.from(JSON.stringify(recording)), { level: 9 });
  const back = JSON.parse(gunzipSync(gz).toString());
  assert.deepEqual(back, recording);
});

test('raceDate returns UTC+2 stage date', () => {
  // 2026-07-09 00:30 UTC is still 2026-07-09 in race-local (UTC+2)
  assert.equal(raceDate(new Date('2026-07-09T00:30:00Z')), '2026-07-09');
  // 2026-07-08 23:00 UTC -> 2026-07-09 01:00 race-local
  assert.equal(raceDate(new Date('2026-07-08T23:00:00Z')), '2026-07-09');
});

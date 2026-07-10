// node --test import-official.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, buildEvents } from './import-official.mjs';

// Two riders on the shared 6s grid, rows newest-first (as the bucket serves them),
// each with a slightly different phase / coverage window.
const CSV_BIB1 =
  'bib,lat,lon,pos,kph,kmToFinish,secToFirstRider,secToITTLead,status,timestamp\n' +
  '1,42.10,-0.10,1,30.0,0.0,0,,finished,2026-07-09T15:00:12.200Z\n' +
  '1,42.11,-0.11,1,31.0,0.5,0,,active,2026-07-09T15:00:06.200Z\n' +
  '1,42.12,-0.12,1,32.0,1.0,0,,active,2026-07-09T15:00:00.200Z\n';

// bib 2 shares the grid but starts one bin later and lacks lat/lon on its last row.
const CSV_BIB2 =
  'bib,lat,lon,pos,kph,kmToFinish,secToFirstRider,secToITTLead,status,timestamp\n' +
  '2,,,3,29.0,0.4,12,,active,2026-07-09T15:00:12.100Z\n' +
  '2,42.21,-0.21,3,29.5,0.9,11,,active,2026-07-09T15:00:06.100Z\n';

test('parseCsv reads columns by header and blanks become null', () => {
  const s = parseCsv(CSV_BIB2);
  assert.equal(s.length, 2);
  assert.equal(s[0].bib, 2);
  assert.equal(s[0].lat, null);
  assert.equal(s[0].lon, null);
  assert.equal(s[0].kph, 29);
  assert.equal(s[0].secToFirstRider, 12);
  assert.ok(Number.isFinite(s[0].tsMs));
});

test('buildEvents bins onto a 6s grid, orders chronologically, computes dt', () => {
  const events = buildEvents({ 1: parseCsv(CSV_BIB1), 2: parseCsv(CSV_BIB2) }, 2026);
  // 3 grid buckets: 15:00:00, 15:00:06, 15:00:12
  assert.equal(events.length, 3);

  const frames = events.map((e) => JSON.parse(e.data));
  // chronological & telemetry bind
  assert.equal(frames[0].bind, 'telemetryCompetitor-2026');
  const ts = frames.map((f) => f.data.TimeStamp);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
  // TimeStamp is unix seconds
  assert.equal(ts[0], Math.round(Date.parse('2026-07-09T15:00:00.200Z') / 6000) * 6);

  // dt: 0 first, then 6000ms gaps
  assert.deepEqual(events.map((e) => e.dt), [0, 6000, 6000]);

  // first frame: only bib 1 (bib 2 starts one bin later)
  assert.deepEqual(frames[0].data.Riders.map((r) => r.Bib), [1]);
  // middle frame: both riders present
  assert.deepEqual(frames[1].data.Riders.map((r) => r.Bib).sort(), [1, 2]);
});

test('buildEvents uses the site capitalized field names and omits absent fields', () => {
  const events = buildEvents({ 2: parseCsv(CSV_BIB2) }, 2026);
  const last = JSON.parse(events[events.length - 1].data).data.Riders[0];
  // last bib-2 row had blank lat/lon -> those keys are omitted
  assert.equal(last.Bib, 2);
  assert.ok(!('Latitude' in last));
  assert.ok(!('Longitude' in last));
  assert.equal(last.kph, 29);
  assert.equal(last.kmToFinish, 0.4);
  assert.equal(last.secToFirstRider, 12);
  // a row WITH coordinates maps lat->Latitude / lon->Longitude
  const withCoords = JSON.parse(events[0].data).data.Riders[0];
  assert.equal(withCoords.Latitude, 42.21);
  assert.equal(withCoords.Longitude, -0.21);
});

test('multiple samples of one rider in a bin keep the one nearest the bin center', () => {
  // two rows for bib 3 in the 15:00:06 bin (center = ...06.000Z): .200 is closer than .900
  const csv =
    'bib,lat,lon,pos,kph,kmToFinish,secToFirstRider,secToITTLead,status,timestamp\n' +
    '3,10,10,1,20,5,0,,active,2026-07-09T15:00:06.900Z\n' +
    '3,11,11,1,21,4,0,,active,2026-07-09T15:00:06.200Z\n';
  const events = buildEvents({ 3: parseCsv(csv) }, 2026);
  assert.equal(events.length, 1);
  const rider = JSON.parse(events[0].data).data.Riders[0];
  assert.equal(rider.Latitude, 11); // the .200Z sample, nearest the bin center
  assert.equal(rider.kph, 21);
});

// node --test import-official.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, buildEvents, buildTraceIndex } from './import-official.mjs';

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

// A 3-point climb: ~1 km at +100 m (≈10% up), then ~1 km flat. 0.009° lat ≈ 1 km.
const TRACE = {
  totalDistance: null, // force distance from geometry
  routePoints: [
    { lat: 43.0, lon: 0, ele: 100 },
    { lat: 43.009, lon: 0, ele: 200 },
    { lat: 43.018, lon: 0, ele: 200 },
  ],
};

test('buildTraceIndex interpolates altitude and gradient from kmToFinish', () => {
  const idx = buildTraceIndex(TRACE);
  assert.ok(idx, 'index built');
  assert.ok(Math.abs(idx.totalKm - 2) < 0.05, `~2km total, got ${idx.totalKm}`);

  // start (kmToFinish == total) → first point
  assert.ok(Math.abs(idx.lookup(idx.totalKm).ele - 100) < 1);
  // finish (kmToFinish 0) → last point
  assert.ok(Math.abs(idx.lookup(0).ele - 200) < 1);
  // quarter from start (75% to go) is on the climb → ~150 m, clearly uphill
  const q = idx.lookup(idx.totalKm * 0.75);
  assert.ok(q.ele > 120 && q.ele < 180, `mid-climb ele ${q.ele}`);
  assert.ok(q.grad > 5, `climb gradient positive, got ${q.grad}`);
  // deep in the flat second half → ~0% grade
  assert.ok(Math.abs(idx.lookup(idx.totalKm * 0.2).grad) < 3, 'flat section ~0%');
});

test('buildEvents injects mAlt/Gradient when a trace index is given', () => {
  const csv =
    'bib,lat,lon,pos,kph,kmToFinish,secToFirstRider,secToITTLead,status,timestamp\n' +
    '7,43.004,0,1,20,1.0,0,,active,2026-07-09T15:00:00.000Z\n';
  const idx = buildTraceIndex(TRACE);
  const rider = JSON.parse(buildEvents({ 7: parseCsv(csv) }, 2026, idx)[0].data).data.Riders[0];
  assert.equal(typeof rider.mAlt, 'number');
  assert.equal(typeof rider.Gradient, 'number');
  assert.ok(rider.mAlt > 100 && rider.mAlt <= 200, `altitude in range, got ${rider.mAlt}`);
  // without a trace index the fields are absent
  const plain = JSON.parse(buildEvents({ 7: parseCsv(csv) }, 2026)[0].data).data.Riders[0];
  assert.ok(!('mAlt' in plain) && !('Gradient' in plain));
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

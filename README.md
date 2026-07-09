# racecenter-data

Central archive of Tour de France stage recordings for the Racecenter Peloton
extension's replay feature. **Public data repo — only recordings live here; the
extension code stays in its own (private) repo.**

Each stage is captured live from `racecenter.letour.fr/live-stream` (the same public
telemetry the official site shows) by a GitHub Actions cron and stored as a
self-contained gzipped recording. Users of the extension only *play back* these
files — nobody records anything client-side.

## Layout

```
recorder.mjs                 # the recorder (zero deps, node >= 20)
recorder.test.mjs            # node --test: SSE parser + gzip roundtrip
.github/workflows/record.yml # cron (July, 10:45 UTC) + manual workflow_dispatch
index.json                   # manifest: [{id, date, name, km, ticks, t0, t1, bytes, file}]
recordings/<date>.json.gz    # one recording per stage (~20-30 MB)
```

## Recording format (inside each `.json.gz`)

```jsonc
{
  "version": 1,
  "meta": { "date": "2026-07-09", "year": 2026, "recordedAt": "…ISO…" },
  "rest": { "riders": [...], "teams": [...], "stages": { "2026-07-09": {...} } },
  "events": [ { "dt": 0, "data": "<verbatim SSE data string>" }, ... ]
}
```

- `rest` is a one-time snapshot of the REST endpoints, embedded so names/teams stay
  correct even if the stage is replayed years later.
- `events` are **all** SSE events (every bind, not just telemetry), each `data` the
  verbatim string and `dt` the milliseconds since the previous event — the exact
  `{dt, data}` shape the extension's mock/replay already consumes.
- Weather travels inside the telemetry itself (`Course`, `RiderWindDir`, `kphWind`,
  `degC` per rider), so it is captured natively — no separate weather series.

## Running it

- **Automatically**: the cron fires each July morning; `workflow_dispatch` is the
  manual backup (optionally pass a `date` to backfill).
- **Locally** (backup / testing): `node recorder.mjs`. It snapshots REST, streams
  the firehose, and on end-of-stage silence (or the 5.5h hard cap) writes
  `recordings/<date>.json.gz` + updates `index.json`. If fewer than 100 telemetry
  ticks were seen (rest day / no stage) it writes nothing.

Env overrides (handy for a quick out-of-hours smoke test):
`RC_DATE`, `RC_BASE`, `RC_SILENCE_MS`, `RC_MAX_MS`, `RC_MIN_TICKS`.

Tests: `node --test recorder.test.mjs`.

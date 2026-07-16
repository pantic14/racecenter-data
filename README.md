# racecenter-data

Central archive of Tour de France stage recordings for the Racecenter Peloton
extension's replay feature. **Public data repo — only recordings live here; the
extension code stays in its own (private) repo.**

Stages are archived as self-contained gzipped recordings from two sources, both
producing the identical format so the extension replays either with no code changes.
Users of the extension only *play back* these files — nobody records anything
client-side.

- **Live recorder (primary)** — `recorder.mjs` captures `racecenter.letour.fr/live-stream`
  (the SSE firehose) during the stage. Richest source: wind, temperature, heading, jersey
  and road position exist ONLY here and can never be recovered afterwards. Altitude is the
  one thing the feed never sends, and the embedded `rest.trace` supplies it.
- **Official importer (safety net)** — `import-official.mjs` downloads ASO's post-stage
  static replay: one `positions.csv` per rider (a ~6s-cadence position timeline for the
  whole stage) from the public GCS bucket that `dansmacourse.letour.fr` uses, and
  rebuilds them into telemetry frames. Cleaner and it can't be missed by a failed cron,
  but it carries no weather — so it covers the days the recorder missed, and `--backfill`
  leaves an existing live recording alone. The bucket keeps a rolling window of roughly
  the last **7 stages** (measured 2026-07-15: stages 4-10 served, 1-3 gone), so a missed
  day is usually still recoverable for a week.

## Layout

```
shared.mjs                   # helpers shared by both scripts (REST snapshot, gzip write, index upsert)
import-official.mjs          # PRIMARY: import ASO's post-stage static positions.csv (zero deps, node >= 20)
import-official.test.mjs     # node --test: CSV parse + frame reconstruction
recorder.mjs                 # FALLBACK: live SSE recorder (zero deps, node >= 20)
recorder.test.mjs            # node --test: SSE parser + gzip roundtrip
.github/workflows/import.yml # cron (July, 20:30 UTC) — daily official import + backfill
.github/workflows/record.yml # cron (July, 10:20 UTC) — live recorder + manual workflow_dispatch
index.json                   # manifest: [{id, date, name, km, ticks, t0, t1, bytes, file, source?}]
recordings/<date>.json.gz    # one recording per stage (official ~3-7 MB, live ~20-30 MB)
```

## Recording format (inside each `.json.gz`)

```jsonc
{
  "version": 1,
  "meta": { "date": "2026-07-09", "year": 2026, "recordedAt": "…ISO…" },
  "rest": { "riders": [...], "teams": [...], "stages": {...}, "trace": {...} },
  "events": [ { "dt": 0, "data": "<verbatim SSE data string>" }, ... ]
}
```

- `rest` is a one-time snapshot of the REST endpoints, embedded so names/teams stay
  correct even if the stage is replayed years later.
- `rest.trace` is the stage's official altimetry (ASO's `trace.json`: `routePoints` plus
  `pointsOfInterest`), embedded by **both** recorders. It is what gives a replay its
  altitude — the live SSE never sends any — and it is stored rather than fetched at replay
  time because the bucket drops old seasons. ~60-80 kB, negligible next to the telemetry.
  Recordings made before this existed have no `trace`; the extension falls back to
  fetching the stage's trace live, which works until that season is purged.
- `events` are the **telemetry** SSE events only (`telemetryCompetitor-<year>` with a
  non-empty `Riders` array), each `data` the verbatim string and `dt` the milliseconds
  since the previous kept event — the exact `{dt, data}` shape the extension's
  mock/replay consumes. The live firehose also carries socialContent/video/image/ranking
  binds, but the replay discards them, so keeping them only bloated recordings ~100x
  and could blow `JSON.stringify` past V8's ~512 MB string limit on busy stages.
- Weather travels inside the telemetry itself (`Course`, `RiderWindDir`, `kphWind`,
  `degC` per rider) in **live** recordings, along with `Jersey`, `Pos` and `Status`. None
  of it exists in ASO's static files, so an **official** recording can never have it: it
  carries position/speed/gap, plus per-rider **altitude (`mAlt`) and road gradient
  (`Gradient`) reconstructed from `rest.trace`** (positions.csv has neither). This is why
  a live recording of a stage is never replaced by an official one.
- `meta.source` is `"official"` for imported stages (absent for live recordings). The
  index entry mirrors it in `source` so the importer knows what to skip on re-runs.

## Running the official importer (safety net)

```
node import-official.mjs --stage 6            # one stage by number
node import-official.mjs --date 2026-07-09     # one stage by date
node import-official.mjs --backfill            # all finished stages we don't hold yet
```

`--backfill` is idempotent: it imports every stage with `date < today` whose bucket data
is available and that isn't already in the index **from either source**, and skips the
rest. So the daily cron catches up **and** picks up each new finished stage, without ever
clobbering a live recording. `--stage` and `--date` DO overwrite, deliberately — that is
the escape hatch when a live recording turns out to be broken.

Env overrides: `RC_YEAR`, `RC_RACE`, `RC_BUCKET_BASE`, `RC_BASE` (REST snapshot host),
`RC_CONCURRENCY`, `RC_MIN_TICKS`.

## Running the live recorder (fallback)

- **Automatically**: the `record.yml` cron fires each July morning; `workflow_dispatch`
  is the manual backup (optionally pass a `date`).
- **Locally**: `node recorder.mjs`. It snapshots REST, streams the firehose, and on
  end-of-stage silence (or the 5.5h hard cap) writes `recordings/<date>.json.gz` +
  updates `index.json`. Fewer than 100 telemetry ticks (rest day / no stage) → writes
  nothing. Env overrides: `RC_DATE`, `RC_BASE`, `RC_SILENCE_MS`, `RC_MAX_MS`, `RC_MIN_TICKS`.

Tests: `node --test import-official.test.mjs recorder.test.mjs`.

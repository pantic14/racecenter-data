# racecenter-data

Central archive of Tour de France stage recordings for the Racecenter Peloton
extension's replay feature. **Public data repo — only recordings live here; the
extension code stays in its own (private) repo.**

Stages are archived as self-contained gzipped recordings from two sources, both
producing the identical format so the extension replays either with no code changes.
Users of the extension only *play back* these files — nobody records anything
client-side.

- **Official importer (primary)** — `import-official.mjs` downloads ASO's post-stage
  static replay: one `positions.csv` per rider (a ~6s-cadence position timeline for the
  whole stage) from the public GCS bucket that `dansmacourse.letour.fr` uses, and
  rebuilds them into telemetry frames. Clean and reliable, but the bucket only keeps
  each stage's `positions.csv` for **~3 days** after it finishes, so it must run daily.
- **Live recorder (fallback)** — `recorder.mjs` captures `racecenter.letour.fr/live-stream`
  (the SSE firehose) live during the stage. Kept as a backup for when the official
  static files aren't published.

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
  "rest": { "riders": [...], "teams": [...], "stages": { "2026-07-09": {...} } },
  "events": [ { "dt": 0, "data": "<verbatim SSE data string>" }, ... ]
}
```

- `rest` is a one-time snapshot of the REST endpoints, embedded so names/teams stay
  correct even if the stage is replayed years later.
- `events` are the **telemetry** SSE events only (`telemetryCompetitor-<year>` with a
  non-empty `Riders` array), each `data` the verbatim string and `dt` the milliseconds
  since the previous kept event — the exact `{dt, data}` shape the extension's
  mock/replay consumes. The live firehose also carries socialContent/video/image/ranking
  binds, but the replay discards them, so keeping them only bloated recordings ~100x
  and could blow `JSON.stringify` past V8's ~512 MB string limit on busy stages.
- Weather travels inside the telemetry itself (`Course`, `RiderWindDir`, `kphWind`,
  `degC` per rider) in **live** recordings. **Official** recordings carry
  position/speed/gap, plus per-rider **altitude (`mAlt`) and road gradient (`Gradient`)
  reconstructed from the stage's `trace.json` elevation profile** (positions.csv itself
  has neither). Only wind, temperature and heading are absent from an official replay.
- `meta.source` is `"official"` for imported stages (absent for live recordings). The
  index entry mirrors it in `source` so the importer knows what to skip on re-runs.

## Running the official importer (primary)

```
node import-official.mjs --stage 6            # one stage by number
node import-official.mjs --date 2026-07-09     # one stage by date
node import-official.mjs --backfill            # all finished stages not yet imported
```

`--backfill` is idempotent: it imports every stage with `date < today` whose bucket
data is available and that isn't already imported from the official source (overwriting
a live recording of the same date once, since official is primary), and skips the rest.
So the daily cron catches up **and** picks up each new finished stage. Because the
bucket purges each stage's `positions.csv` after ~3 days, missing a few days loses those
stages from the official source permanently — that's what the live recorder backs up.

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

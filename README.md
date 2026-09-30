# ethereum-key-status

A small Node.js (TypeScript) service that checks the on-chain status of one or
more sets of Ethereum validator keys against one or more beacon (consensus)
nodes, aggregates the results, writes them to disk, and optionally posts a
summary card per key set to a Microsoft Teams channel.

It runs either as a **one-off check** (`--once`) or as a **long-running
scheduler** that repeats the check on a cron schedule - by default at 00:00
on the first day of every quarter, like the old host crontab - and ships as a Docker image, so no host
crontab is needed.

It was built to monitor Lido CSM validator keys - both **CMv1** (`0x01`
withdrawal credentials, 32 ETH per validator) and **CMv2** (`0x02`
compounding credentials, up to 2048 ETH per validator) - but works with any
list of validator public keys.

## What it does

On each run (`src/run.ts`):

1. **Loads the key sets** to check (`keysets.json`, see
   [Key sets](#key-sets)). Each set has its own key file, type and Teams card.
   The file is re-read on every run, so edits apply to the next scheduled run
   without a restart.
2. **Checks the configured beacon nodes** (`NODE_ENDPOINT`) via
   `/eth/v1/node/syncing` and keeps only the nodes that are fully synced.
   If none are available, the run fails (exit code `1` with `--once`).
3. **Queries validator status** for every key set from the first node that
   answers, via `POST /eth/v1/beacon/states/head/validators` (one request for
   the whole set), falling back to chunked `GET` requests on clients that do
   not support the POST form.
4. **Resolves keys the beacon chain does not know about** against the Electra
   deposit queue (`/eth/v1/beacon/states/head/pending_deposits`) - see
   [The deposit queue](#the-deposit-queue).
5. **Aggregates the results** into counts per state, plus balance statistics
   and the [frontiers](#frontiers) for `0x02` keys, and a per-batch breakdown
   for CMv1 sets.
6. **Writes a timestamped report** per key set to
   `results/results-<key-set>-<timestamp>.json` (`RESULTS_DIR`).
7. **Posts a summary** as an Adaptive Card to a Microsoft Teams webhook
   (`WEBHOOK_URL`), one card per key set, if one is configured.

## Requirements

- Either Docker (recommended, see [Running with Docker](#running-with-docker)),
  or Node.js 20+ (uses the built-in global `fetch`).
- Network access to at least one Ethereum beacon node's HTTP API.
- For deposit-queue tracking: a post-Electra beacon node that serves
  `/eth/v1/beacon/states/{state_id}/pending_deposits`. Without it the tool
  still runs, but keys with no validator record are reported as `unknown`
  instead of being split into `in_deposit_queue` and `not_deposited`.

## Installation

Without Docker:

```bash
npm install
npm run build      # compiles src/ to dist/
```

The sources are TypeScript (strict mode, ES modules) under `src/`; `npm run
build` emits plain JavaScript to `dist/`, which is what runs. `npm run
typecheck` checks sources and tests without emitting, and `npm test` runs
the unit tests (no network access needed).

## Configuration

Configuration is read from environment variables (a `.env` file in the
working directory is supported via `dotenv`; variables set in the real
environment take precedence). Copy the example and fill it in:

```bash
cp .env.example .env
```

| Variable                      | Default                                        | Description                                                                                                     |
| ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `NODE_ENDPOINT`               | `127.0.0.1:5052,127.0.0.1:3500,127.0.0.1:5051` | Comma-separated `host:port` list of beacon node HTTP endpoints. Tried in order until one answers.                |
| `KEYSETS_PATH`                | `./keysets.json`                               | Path to the key set config. If the file is absent, the two variables below define a single CMv1 set. The Docker image sets `/app/config/keysets.json`. |
| `KEY_JSON_PATH`               | `keys.json`                                    | Key file for the single-set fallback. The Docker image sets `/app/config/keys.json`.                             |
| `CHUNK_SIZE`                  | `500`                                          | Keys per request for the single-set fallback, and for the `GET` fallback generally.                              |
| `WEBHOOK_URL`                 | _(empty)_                                      | Microsoft Teams **Workflows** incoming webhook URL. If empty (and the set has no `webhookUrl`), posting fails with `No Webhook URL`: the report is still written, but the run counts as failed (`--once` exits `1`). |
| `DEPOSIT_CHURN_ETH_PER_EPOCH` | `256`                                          | Per-epoch deposit churn used to estimate queue wait time. Mainnet caps this at 256 ETH.                          |
| `MAX_CARD_BYTES`              | `16000`                                        | Size budget per Teams card. Per-key rows are split across several posts when they would exceed it.               |
| `MAX_FACTS_PER_CARD`          | `100`                                          | Maximum per-key rows on one card. Long FactSets fail to render before they hit any byte limit.                   |
| `FRONTIER_WINDOW`             | `2`                                            | Keys shown either side of a frontier on a CMv2 card.                                                             |
| `CMV2_MAX_BALANCE_ETH`        | `2048`                                         | EIP-7251 compounding cap a `0x02` key fills up to. Defines the fill frontier.                                    |
| `WEBHOOK_DELAY_MS`            | `500`                                          | Pause between posts when one key set needs more than one card.                                                   |
| `RESULTS_DIR`                 | `./results`                                    | Where the JSON reports are written, relative to the working directory. The Docker image sets `/app/results`.     |
| `LOG_DIR`                     | `.` (working directory)                        | Where `combined.log` and `error.log` are written. The Docker image sets `/app/logs`.                             |
| `SCHEDULE`                    | `0 0 1 */3 *`                                  | Cron expression for scheduler mode - see [Scheduling](#scheduling). Default: 00:00 on the first day of each quarter. |
| `TZ`                          | _(system / container zone, UTC in the image)_  | Process time zone: used for the schedule and for log timestamps, e.g. `Europe/Vienna`.                           |
| `SCHEDULE_TIMEZONE`           | _(the process zone, i.e. `TZ`)_                | IANA zone the schedule alone is evaluated in, if it should differ from `TZ`.                                      |
| `RUN_ON_START`                | `false`                                        | `true` also runs a check immediately when the scheduler starts.                                                  |
| `HEARTBEAT_FILE`              | `<tmpdir>/keystatus.heartbeat`                 | Liveness file the scheduler touches every 30 s, read by the Docker `HEALTHCHECK`. Set to an empty value to disable. |

Numeric settings that are empty, not a number, or `0` fall back to their
default.

### Key sets

A run checks one or more key sets and posts **one card per set**. Declare
them in `keysets.json` (see `keysets.example.json`):

```json
[
  {
    "name": "Lido CSM v1",
    "type": "cmv1",
    "keyFile": "./keys-cmv1.json",
    "chunkSize": 500
  },
  {
    "name": "Lido CSM v2 (Obol DVT)",
    "type": "cmv2",
    "keyFile": "./keys-cmv2.json"
  }
]
```

| Field        | Required | Description                                                                                  |
| ------------ | -------- | -------------------------------------------------------------------------------------------- |
| `name`       | no       | Card title and report filename. Defaults to the key file's basename.                          |
| `type`       | no       | `cmv1` (default) or `cmv2`. Selects the defaults below.                                       |
| `keyFile`    | **yes**  | Path to this set's key JSON file, relative to the working directory (`/app` in Docker). `keyJsonPath` is accepted as an alias. |
| `chunkSize`  | no       | Keys per request for the `GET` fallback. Default `500`.                                       |
| `webhookUrl` | no       | Post this set to a different channel than `WEBHOOK_URL`.                                      |
| `perKeyCard` | no       | `true` lists every key on the card. Off by default - at 500 keys it is unreadable and needs several posts. |

`type` selects the reporting style:

| Type   | Credentials       | Card                                                           | Batches |
| ------ | ----------------- | -------------------------------------------------------------- | ------- |
| `cmv1` | `0x01`, 32 ETH    | Aggregate counts only.                                          | Yes - per-`chunkSize` breakdown of active validators. |
| `cmv2` | `0x02`, up to 2048 ETH | Aggregate counts, balance statistics and the two [frontiers](#frontiers). | No - a CMv2 set is capped at 500 keys on a single Obol DVT cluster, so there is nothing to split. |

The file may also wrap the list as `{ "keySets": [ ... ] }`.

If `keysets.json` is absent the tool falls back to a single CMv1 set built
from `KEY_JSON_PATH` and `CHUNK_SIZE`, so an existing `.env` keeps working
unchanged on a host install. In Docker the key file has to be under the
`config/` mount instead - see [Legacy single-set mode in
Docker](#legacy-single-set-mode-in-docker).

### Key file format

Each `keyFile` must point to a JSON array of objects, each with at least a
`pubkey` field:

```json
[
  {
    "pubkey": "0xaf59776ab9eafa0c9524f1e76daafaa5666c8ea16e129274bcefa8c72d8d4ddd6e71f409b9da43a05ca4ea5d1033ebf3",
    "genIndex": 0
  }
]
```

## Frontiers

Listing all 500 keys says very little, so a CMv2 card reports two boundaries
instead, each with a small window of keys either side (`FRONTIER_WINDOW`):

- **Deposit frontier** - the last key that made it onto the chain (active or
  still queued) and the first one behind it that has not been deposited at
  all. This is how far down the key list deposits have reached.
- **Fill frontier** - the first key still below the `CMV2_MAX_BALANCE_ETH`
  (2048 ETH) compounding cap, which is where the next top-up lands.

Both are also written to the log and to the JSON report (`frontiers`), as
positions in the key file.

## The deposit queue

Since Electra, a deposit made on the execution chain does not create a
validator record immediately - it waits in the beacon chain's pending-deposit
queue, which can take weeks to drain. A key in that queue is invisible to
`/eth/v1/beacon/states/head/validators`, and the `pending_*` statuses only
appear once the deposit has already been processed.

The tool therefore looks up every key without a validator record in
`/eth/v1/beacon/states/head/pending_deposits` and reports it as:

| State              | Meaning                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `in_deposit_queue` | Deposit made on-chain, waiting to be processed. Reported with its queue position and an estimated wait. |
| `not_deposited`    | In the key file, but no validator record and no queued deposit.             |
| `unknown`          | As above, but the node could not serve the queue, so the two cannot be told apart. |

**Active count.** The headline "Active (incl. queue)" figure counts every key
the operator is committed to: all `active_*` states, all `pending_*` states,
and `in_deposit_queue`. Keys that have not been deposited at all are excluded.

The estimated wait is `ETH ahead in the queue / DEPOSIT_CHURN_ETH_PER_EPOCH`
epochs. It is an estimate of when processing *starts*; activation adds further
delay on top.

For `0x02` keys the queue is also checked for **top-ups** - additional ETH
sent towards the 2048 ETH cap for an already-active validator. These show on
the card as `+<amount> ETH queued`.

## Usage

The entry point is `dist/index.js` (after `npm run build`):

| Command                          | npm script      | What it does                                                         |
| -------------------------------- | --------------- | -------------------------------------------------------------------- |
| `node dist/index.js --once`      | `npm run check` | One full status check, then exit `0` or `1` (see [Exit codes](#exit-codes)). |
| `node dist/index.js`             | `npm start`     | Scheduler mode: stays running and checks on every `SCHEDULE` tick.   |
| `node dist/index.js --schedule`  |                 | Same as above, spelled out.                                          |
| `node dist/test-webhook.js`      | `npm run test:webhook` | Posts sample cards to `WEBHOOK_URL` - see [Testing the webhook](#testing-the-webhook). |

Output is logged to the console and to `combined.log` / `error.log` (in
`LOG_DIR`), and a detailed JSON report per key set is written to
`RESULTS_DIR`, including per-key balance, effective balance, withdrawal
credential type and queue position.

## Scheduling

In scheduler mode the process runs the same check as `--once` on the
`SCHEDULE` cron expression, evaluated in `SCHEDULE_TIMEZONE` (or `TZ`, or the
system zone). It uses [croner](https://croner.56k.guru), which supports the
standard five fields plus an optional leading seconds field, and `L` for the
last day of the month.

```
┌───────── minute (0-59)
│ ┌─────── hour (0-23)
│ │ ┌───── day of month (1-31, L = last day)
│ │ │ ┌─── month (1-12)
│ │ │ │ ┌─ day of week (0-7, SUN-SAT)
0 0 1 */3 *
```

| `SCHEDULE`           | Runs                                                            |
| -------------------- | --------------------------------------------------------------- |
| `0 0 1 */3 *`        | **Default** (same as the old crontab). 00:00 on 1 Jan, 1 Apr, 1 Jul and 1 Oct. |
| `0 9 1 1,4,7,10 *`   | 09:00 on the first day of each quarter.                         |
| `30 23 L 3,6,9,12 *` | 23:30 on the last day of each quarter.                          |
| `0 9 L * *`          | 09:00 on the last day of every month.                           |
| `0 8 * * MON`        | Every Monday at 08:00.                                          |
| `*/15 * * * *`       | Every 15 minutes (handy for trying it out).                     |

With `TZ=Europe/Vienna` the default fires at midnight Vienna time, i.e.
22:00 UTC (summer) or 23:00 UTC (winter) on the previous day.

Behaviour:

- The next run time is logged at start-up and after every run
  (`Next scheduled run: 2027-01-01 00:00:00 Europe/Vienna (2026-12-31T23:00:00.000Z)`).
- A failed run is logged and the scheduler keeps going; it never exits
  because of one.
- Runs never overlap: a tick that arrives while a check is still running is
  skipped with a warning.
- `keysets.json` and the key files are re-read on every run. Environment
  variables are read once at start-up - restart after changing them.
- An invalid `SCHEDULE` or `SCHEDULE_TIMEZONE` stops the process at start-up
  with exit code `1` and a message saying what is wrong.
- On `SIGTERM` (`docker stop`) or `SIGINT` (Ctrl+C) it stops scheduling,
  waits for a check in progress to finish, and exits `0`. A second signal
  exits immediately. Give `docker stop` enough time (`-t`, or
  `stop_grace_period` in compose) if a run can take longer than 10 s.
- `RUN_ON_START=true` runs one check immediately after start-up as well.

## Running with Docker

The image is multi-stage: the build stage installs all dependencies,
type-checks, runs the tests and compiles; the runtime stage
(`node:22-alpine`) contains only production dependencies and `dist/`, runs as
the unprivileged `node` user (uid 1000) under `tini` so signals reach the
process, and includes `tzdata` so `TZ` works. Its default command is
scheduler mode.

Released images are published to GHCR as
`ghcr.io/rocklogicgmbh/ethereum-key-status` (see [Release
process](#release-process)). `docker-compose.yml` uses that image,
`${KEYSTATUS_IMAGE:-ghcr.io/rocklogicgmbh/ethereum-key-status}:${KEYSTATUS_IMAGE_TAG:-latest}`,
so a server only needs the compose file, `.env` and `config/` - not the
source. Pin `KEYSTATUS_IMAGE_TAG` to a release in `.env` and update by
changing it and running `docker compose pull && docker compose up -d`.
`docker compose build` builds the same tag from source instead.

### docker compose

Lay out the host directory like this:

```
.
├── docker-compose.yml
├── .env                    # from .env.example (NODE_ENDPOINT, WEBHOOK_URL, TZ, ...)
├── config/                 # mounted read-only at /app/config
│   ├── keysets.json
│   ├── keys-cmv1.json
│   └── keys-cmv2.json      # (legacy single-set mode: only keys.json here)
├── results/                # reports, mounted at /app/results
└── logs/                   # combined.log / error.log, mounted at /app/logs
```

Key file paths in `config/keysets.json` are resolved inside the container,
so point them at the mount - either absolute or relative to `/app`:

```json
[
  { "name": "Lido CSM v1", "type": "cmv1", "keyFile": "/app/config/keys-cmv1.json" },
  { "name": "Lido CSM v2 (Obol DVT)", "type": "cmv2", "keyFile": "./config/keys-cmv2.json" }
]
```

#### Legacy single-set mode in Docker

Without a `keysets.json` (only `KEY_JSON_PATH` and `CHUNK_SIZE` in `.env`),
put the key file into `config/` as `config/keys.json`. The image and the
compose file set `KEY_JSON_PATH=/app/config/keys.json` (compose overrides
whatever `.env` says). With plain `docker run --env-file .env`, the
`.env` file wins over the image defaults, so a host-style
`KEY_JSON_PATH=./keys.json` or `KEYSETS_PATH=./keysets.json` there points
at `/app/keys.json` / `/app/keysets.json`, which are not mounted, and every
run fails with `Error reading file ./keys.json: ENOENT`. Remove those two
lines from `.env` (they are commented out in `.env.example`), or pass them
with `-e` as in the [plain docker](#plain-docker) example.

The container writes as uid 1000, so make the output directories writable
for it (or set `user:` in the compose file to the uid that owns them):

```bash
mkdir -p config results logs
sudo chown 1000:1000 results logs
```

Then:

```bash
docker compose up -d --build          # start the scheduler
docker compose logs -f keystatus      # watch it; shows the next run time
docker compose run --rm keystatus node dist/index.js --once   # one check now
docker compose run --rm keystatus node dist/test-webhook.js   # test the webhook
docker compose down                   # stop (waits for a running check)
```

`restart: unless-stopped` brings the scheduler back after a reboot or a
crash. `docker compose ps` shows the health state from the heartbeat-based
`HEALTHCHECK`.

**Reaching the beacon nodes.** The container uses the default bridge
network and reaches beacon nodes on other hosts directly: set `NODE_ENDPOINT`
in `.env` to their address (e.g. `NODE_ENDPOINT=10.0.0.12:5052,10.0.0.12:3500`).
`127.0.0.1` inside the container is the container itself, so the built-in
default only works if you switch to host networking - uncomment
`network_mode: host` in `docker-compose.yml` (Linux) when a beacon node runs on
the Docker host itself and listens on `127.0.0.1` only.

### Plain docker

```bash
IMAGE=ghcr.io/rocklogicgmbh/ethereum-key-status:2.0.0   # or: docker build -t keystatus .
# -e after --env-file: pins the in-container paths even if .env still has
# host-relative KEYSETS_PATH / KEY_JSON_PATH values.
PATHS="-e KEYSETS_PATH=/app/config/keysets.json -e KEY_JSON_PATH=/app/config/keys.json"
docker run -d --name keystatus --restart unless-stopped \
  --env-file .env $PATHS -e TZ=Europe/Vienna \
  -v "$PWD/config:/app/config:ro" -v "$PWD/results:/app/results" -v "$PWD/logs:/app/logs" \
  "$IMAGE"
docker run --rm --env-file .env $PATHS \
  -v "$PWD/config:/app/config:ro" -v "$PWD/results:/app/results" \
  "$IMAGE" node dist/index.js --once
```

`--env-file` takes precedence over the image's `ENV` defaults, so without
the `-e` flags a `.env` copied from an older setup (with
`KEYSETS_PATH=./keysets.json` / `KEY_JSON_PATH=./keys.json`) makes every run
fail with `ENOENT`.

### Migrating from the host cronjob

The scheduler replaces the host crontab entry that ran the check every
quarter:

```
0 0 1 */3 * cd ~/ethereum-key-status && npm run check
```


1. Move the key configuration into `config/` first - the container only sees
   that directory:
   - With a `keysets.json`: move it and the key files into `config/` and
     update their `keyFile` paths (see [docker compose](#docker-compose)).
   - Legacy single-set mode (only `KEY_JSON_PATH` / `CHUNK_SIZE` in `.env`,
     no `keysets.json`): move `keys.json` to `config/keys.json`. Compose sets
     `KEY_JSON_PATH=/app/config/keys.json`; with plain `docker run`, also
     drop `KEY_JSON_PATH` / `KEYSETS_PATH` from `.env` or pass them with `-e`
     (see [Legacy single-set mode in
     Docker](#legacy-single-set-mode-in-docker)).

   Create `results/` and `logs/` and chown them to uid 1000 (see above). Old
   reports under `results/` can stay where they are if you mount the same
   directory. `combined.log` / `error.log` in the repo root are not carried
   over - the container starts new ones in `logs/`; move the old files there
   if you want one continuous log.
2. Check the configuration with a single run:
   `docker compose run --rm keystatus node dist/index.js --once` (it posts
   to Teams). It must exit `0`; `Error reading file ... ENOENT` means a key
   file path does not point into `/app/config`.
3. Build and start the scheduler (`docker compose up -d --build`), with
   `SCHEDULE` matching what the cronjob did (the default `0 0 1 */3 *` is the
   same expression) and `TZ` set to the host's zone (cron used the host's
   local time), and check
   `docker compose logs keystatus` for the `Next scheduled run` line.
4. Remove the old entry from the host (`crontab -e`, or the file under
   `/etc/cron.d/`) so the check does not run - and post to Teams - twice.

Note that `node index.js` no longer exists: the code now lives in `src/`
and runs from `dist/` after `npm run build`, and without arguments it starts
the scheduler instead of checking once. A host that keeps invoking it
directly must use `node dist/index.js --once`.

## Microsoft Teams integration

The summary is sent as an [Adaptive Card](https://adaptivecards.io/) to a
Teams channel, one card per key set.

> **Note:** Microsoft has retired the legacy **Office 365 Connector**
> webhooks. This app targets the newer **Workflows** (Power Automate)
> webhooks. Create one in Teams via
> *channel > Workflows > "Post to a channel when a webhook request is
> received"* and use the generated URL as `WEBHOOK_URL`.

The card uses Adaptive Card schema **1.5** (the maximum the Teams client
currently renders) and stringifies all values, since Teams `FactSet` fields
must be strings.

A CMv2 card carries the summary plus the two frontier windows:

```
Lido CSM v2 (Obol DVT)
  Keys                    500
  Active (incl. queue)    127
  active_ongoing            6
  in_deposit_queue        121
  not_deposited           373
  Total balance       4064.01 ETH
  Avg / min / max       32.00 / 32.00 / 32.01 ETH

  Deposit frontier - last key on chain -> first not deposited
     #125 0x8b8159   32.00 ETH | in queue #55119 | ~31 d
  => #126 0x51344c   32.00 ETH | in queue #55120 | ~31 d
    #127 0xf42cb4    not deposited
    #128 0xfe6736    not deposited

  Fill frontier - first key below 2048 ETH
  => #0 0xd1a5ac     32.00 ETH | active_ongoing
     #1 0x6ab9f1     32.00 ETH | active_ongoing
     #2 0x015f7e     32.01 ETH | active_ongoing
```

`=>` marks the frontier key itself, and a key whose withdrawal credentials are
not `0x02` is flagged `non-compounding` - it cannot accumulate past 32 ETH.

Setting `"perKeyCard": true` on a key set restores the full listing, one row
per key, spread over as many cards as the size budget allows.

Teams Workflows answers `202 Accepted` as soon as it receives the POST -
*before* it tries to render the card. An oversized payload is therefore
accepted and then **silently dropped**: nothing in the response says the card
never reached the channel. The documented ceiling is around 28 KB, so the
defaults stay well under it and cap the row count as well.

A key set whose rows exceed `MAX_CARD_BYTES` or `MAX_FACTS_PER_CARD` is posted
as a **summary card followed by numbered row cards** (`... - keys (1/2)`,
`... - keys (2/2)`). The rows are spread evenly rather than packing the first
card to the limit, and the summary always gets a card of its own so the
headline numbers cannot be the thing that gets dropped. At 500 keys this is
six posts of under 8 KB each.

The log records the size of every post (`Webhook accepted (HTTP 202, 4.7 KB)`)
so a card that vanishes can be traced.

### Testing the webhook

To verify your `WEBHOOK_URL` is wired up correctly without running a full key
check, send sample cards:

```bash
npm run build && npm run test:webhook
```

It posts one CMv1 and one CMv2 sample card and exits `0` on success or `1` on
failure. A delivered message logs `Webhook accepted (HTTP 202, ...)` - Teams
Workflows reply with `202 Accepted` and an empty body. In Docker:
`docker compose run --rm keystatus node dist/test-webhook.js`.

## Development

```bash
npm install
npm run typecheck   # tsc over src/ and test/, no output
npm test            # node:test via tsx; mocks fetch, never touches the network
npm run build       # src/ -> dist/
```

The tests cover card building and splitting (including the ASCII-only
output), the report and frontiers, key set loading and its fallbacks, the
beacon client against a mocked `fetch`, a full run against a mocked node and
webhook, and the scheduler (the default resolves to 00:00 on 1 January,
April, July and October; runs do not overlap; shutdown waits for a
running check).

## Release process

Images are built by `.github/workflows/docker.yml` and pushed to GHCR
(`ghcr.io/rocklogicgmbh/ethereum-key-status`). The image build runs the
type check and the tests, so a failing test stops the release. Pushes to
branches do not build images.

1. Bump `version` in `package.json` (`npm version X.Y.Z --no-git-tag-version`,
   which also updates `package-lock.json`) and merge to `main`.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow
   fails if the tag does not match the version in `package.json`. It
   publishes `X.Y.Z`, `X.Y`, `X` (not for `0.x`) and `latest`.
3. For an edge build from `main`, run the workflow manually
   (workflow_dispatch) on `main`. It publishes `edge` and `sha-<commit>`.
   Manual runs on other branches are rejected.

## Project layout

| File                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `src/index.ts`         | CLI entry point: `--once` or scheduler mode, signal handling.        |
| `src/run.ts`           | One check: orchestrates the run, writes reports, posts cards.        |
| `src/scheduler.ts`     | Cron scheduling (croner), overlap protection, graceful stop, heartbeat. |
| `src/config.ts`        | Parses the environment variables into typed config.                   |
| `src/env.ts`           | Loads `.env` before anything else is imported.                       |
| `src/keysets.ts`       | Resolves which key sets a run checks.                                |
| `src/beacon.ts`        | Beacon node HTTP API access (syncing, validators, deposit queue).    |
| `src/status.ts`        | Turns raw beacon data into the per-key-set report.                   |
| `src/cards.ts`         | Builds the Adaptive Cards, splitting per-key cards to fit Teams.     |
| `src/logger.ts`        | Winston logger writing to the console, `combined.log`, `error.log`.  |
| `src/types.ts`         | Beacon API, key set, report and card types.                          |
| `src/test-webhook.ts`  | Standalone Teams webhook connectivity test.                          |
| `src/healthcheck.ts`, `src/heartbeat.ts` | Docker `HEALTHCHECK` probe and the heartbeat file location. |
| `test/`                | Unit tests (`node:test`) and fixtures.                               |
| `Dockerfile`, `docker-compose.yml` | Container image and deployment.                          |
| `.github/workflows/docker.yml` | Builds the image on `vX.Y.Z` tags and pushes it to GHCR.  |
| `keysets.example.json` | Template for the key set config.                                     |
| `.env.example`         | Template for the supported environment variables.                    |
| `dist/`                | Compiled output of `npm run build` (git-ignored).                    |
| `results/`             | Timestamped JSON reports from each run (git-ignored).                |

## Exit codes

`--once` (and `npm run check`):

- `0` - completed successfully.
- `1` - no synced beacon node available, an invalid key set config, or at
  least one key set failed to produce data or deliver its card.

Scheduler mode (the default):

- Keeps running across failed checks; failures are only logged.
- `0` - stopped by `SIGTERM` / `SIGINT` after any running check finished.
- `1` - invalid `SCHEDULE` / `SCHEDULE_TIMEZONE` or command-line arguments at
  start-up, or a second signal during shutdown.

`test:webhook`: `0` if every sample card was accepted, `1` otherwise.

## License

MIT - see [LICENSE](./LICENSE).

# ethereum-key-status

A small Node.js tool that checks the on-chain status of one or more sets of
Ethereum validator keys against one or more beacon (consensus) nodes,
aggregates the results, writes them to disk, and optionally posts a summary
card per key set to a Microsoft Teams channel.

It was built to monitor Lido CSM validator keys — both **CMv1** (`0x01`
withdrawal credentials, 32 ETH per validator) and **CMv2** (`0x02`
compounding credentials, up to 2048 ETH per validator) — but works with any
list of validator public keys.

## What it does

On each run (`index.js`):

1. **Loads the key sets** to check (`keysets.json`, see
   [Key sets](#key-sets)). Each set has its own key file, type and Teams card.
2. **Checks the configured beacon nodes** (`NODE_ENDPOINT`) via
   `/eth/v1/node/syncing` and keeps only the nodes that are fully synced.
   If none are available, it exits with code `1`.
3. **Queries validator status** for every key set from the first node that
   answers, via `POST /eth/v1/beacon/states/head/validators` (one request for
   the whole set), falling back to chunked `GET` requests on clients that do
   not support the POST form.
4. **Resolves keys the beacon chain does not know about** against the Electra
   deposit queue (`/eth/v1/beacon/states/head/pending_deposits`) — see
   [The deposit queue](#the-deposit-queue).
5. **Aggregates the results** into counts per state, plus balance statistics
   for `0x02` keys and a per-batch breakdown for CMv1 sets.
6. **Writes a timestamped report** per key set to
   `results/results-<key-set>-<timestamp>.json`.
7. **Posts a summary** as an Adaptive Card to a Microsoft Teams webhook
   (`WEBHOOK_URL`), one card per key set, if one is configured.

## Requirements

- Node.js 18+ (uses the built-in global `fetch`).
- Network access to at least one Ethereum beacon node's HTTP API.
- For deposit-queue tracking: a post-Electra beacon node that serves
  `/eth/v1/beacon/states/{state_id}/pending_deposits`. Without it the tool
  still runs, but keys with no validator record are reported as `unknown`
  instead of being split into `in_deposit_queue` and `not_deposited`.

## Installation

```bash
npm install
```

## Configuration

Configuration is read from environment variables (a `.env` file is supported
via `dotenv`). Copy the example and fill it in:

```bash
cp .env.example .env
```

| Variable                      | Default                                        | Description                                                                                                     |
| ----------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `NODE_ENDPOINT`               | `127.0.0.1:5052,127.0.0.1:3500,127.0.0.1:5051` | Comma-separated `host:port` list of beacon node HTTP endpoints. Tried in order until one answers.                |
| `KEYSETS_PATH`                | `./keysets.json`                               | Path to the key set config. If the file is absent, the two variables below define a single CMv1 set.             |
| `KEY_JSON_PATH`               | `keys.json`                                    | Key file for the single-set fallback.                                                                            |
| `CHUNK_SIZE`                  | `500`                                          | Keys per request for the single-set fallback, and for the `GET` fallback generally.                              |
| `WEBHOOK_URL`                 | _(empty)_                                      | Microsoft Teams **Workflows** incoming webhook URL. If empty, the Teams notification is skipped.                 |
| `DEPOSIT_CHURN_ETH_PER_EPOCH` | `256`                                          | Per-epoch deposit churn used to estimate queue wait time. Mainnet caps this at 256 ETH.                          |
| `MAX_CARD_BYTES`              | `25000`                                        | Size budget per Teams card. Per-key cards are split across several posts when they would exceed it.              |
| `WEBHOOK_DELAY_MS`            | `500`                                          | Pause between posts when one key set needs more than one card.                                                   |

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
| `keyFile`    | **yes**  | Path to this set's key JSON file.                                                             |
| `chunkSize`  | no       | Keys per request for the `GET` fallback. Default `500`.                                       |
| `webhookUrl` | no       | Post this set to a different channel than `WEBHOOK_URL`.                                      |

`type` selects the reporting style:

| Type   | Credentials     | Card                                                        | Batches |
| ------ | --------------- | ----------------------------------------------------------- | ------- |
| `cmv1` | `0x01`, 32 ETH  | Aggregate counts only.                                       | Yes — per-`chunkSize` breakdown of active validators. |
| `cmv2` | `0x02`, ≤2048 ETH | Summary plus **one row per key** with its balance and state. | No — a CMv2 set is capped at 500 keys on a single Obol DVT cluster, so there is nothing to split. |

If `keysets.json` is absent the tool falls back to a single CMv1 set built
from `KEY_JSON_PATH` and `CHUNK_SIZE`, so an existing `.env` keeps working
unchanged.

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

## The deposit queue

Since Electra, a deposit made on the execution chain does not create a
validator record immediately — it waits in the beacon chain's pending-deposit
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

The estimated wait is `ETH ahead in the queue ÷ DEPOSIT_CHURN_ETH_PER_EPOCH`
epochs. It is an estimate of when processing *starts*; activation adds further
delay on top.

For `0x02` keys the queue is also checked for **top-ups** — additional ETH
sent towards the 2048 ETH cap for an already-active validator. These show on
the card as `+<amount> ETH queued`.

## Usage

Run a full status check:

```bash
npm run check
# or
node index.js
```

Output is logged to the console and to `combined.log` / `error.log`, and a
detailed JSON report per key set is written to the `results/` directory,
including per-key balance, effective balance, withdrawal credential type and
queue position.

## Microsoft Teams integration

The summary is sent as an [Adaptive Card](https://adaptivecards.io/) to a
Teams channel, one card per key set.

> **Note:** Microsoft has retired the legacy **Office 365 Connector**
> webhooks. This app targets the newer **Workflows** (Power Automate)
> webhooks. Create one in Teams via
> *channel → Workflows → "Post to a channel when a webhook request is
> received"* and use the generated URL as `WEBHOOK_URL`.

The card uses Adaptive Card schema **1.5** (the maximum the Teams client
currently renders) and stringifies all values, since Teams `FactSet` fields
must be strings.

A CMv2 card lists one row per key, e.g.:

```
0xaf59776a…33ebf3    2048.00 ETH · active_ongoing
0xb1c2d3e4…009988    1056.42 ETH · active_ongoing · +256.00 ETH queued
0xc2d3e4f5…998877      32.00 ETH · active_ongoing · ⚠ 0x01
0xd3e4f5a6…887766      32.00 ETH · in queue #48213 · ~40 d
0xe4f5a697…776655    not deposited
```

A `⚠` marks a CMv2 key whose withdrawal credentials are not `0x02` — it
cannot accumulate past 32 ETH.

Teams rejects payloads over roughly 28 KB, so a key set whose rows exceed
`MAX_CARD_BYTES` is posted as several numbered cards (`… (1/2)`, `… (2/2)`).
At 500 keys this is two posts.

### Testing the webhook

To verify your `WEBHOOK_URL` is wired up correctly without running a full key
check, send sample cards:

```bash
npm run test:webhook
```

It posts one CMv1 and one CMv2 sample card and exits `0` on success or `1` on
failure. A delivered message logs `Webhook delivered (HTTP 202)` — Teams
Workflows reply with `202 Accepted` and an empty body.

## Project layout

| File                   | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `index.js`             | Entry point: orchestrates the run, writes reports, posts cards.      |
| `keysets.js`           | Resolves which key sets a run checks.                                |
| `beacon.js`            | Beacon node HTTP API access (syncing, validators, deposit queue).    |
| `status.js`            | Turns raw beacon data into the per-key-set report.                   |
| `cards.js`             | Builds the Adaptive Cards, splitting per-key cards to fit Teams.     |
| `logger.js`            | Winston logger writing to the console, `combined.log`, `error.log`.  |
| `test-webhook.js`      | Standalone Teams webhook connectivity test.                          |
| `keysets.example.json` | Template for the key set config.                                     |
| `.env.example`         | Template for the supported environment variables.                    |
| `results/`             | Timestamped JSON reports from each run (git-ignored).                |

## Exit codes

- `0` — completed successfully.
- `1` — no synced beacon node available, an invalid key set config, at least
  one key set failed to produce data or deliver its card, or (for
  `test:webhook`) the webhook send failed.

## License

MIT — see [LICENSE](./LICENSE).

# ethereum-key-status

A small Node.js tool that checks the on-chain status of a set of Ethereum
validator keys against one or more beacon (consensus) nodes, aggregates the
results, writes them to disk, and optionally posts a summary card to a
Microsoft Teams channel.

It was built to monitor Lido validator keys, but works with any list of
validator public keys.

## What it does

On each run (`index.js`):

1. **Reads keys** from a JSON file (`KEY_JSON_PATH`).
2. **Checks the configured beacon nodes** (`NODE_ENDPOINT`) via
   `/eth/v1/node/syncing` and keeps only the nodes that are fully synced.
   If none are available, it exits with code `1`.
3. **Queries validator status** from the first available node via
   `/eth/v1/beacon/states/head/validators`, in batches of `CHUNK_SIZE`
   public keys per request.
4. **Aggregates the results** into counts per status (e.g. `active_ongoing`,
   `withdrawal_possible`, `withdrawal_done`) plus a per-batch breakdown of
   active validators.
5. **Writes a timestamped report** to `results/results-<timestamp>.json`.
6. **Posts a summary** as an Adaptive Card to a Microsoft Teams webhook
   (`WEBHOOK_URL`), if one is configured.

## Requirements

- Node.js 18+ (uses the built-in global `fetch`).
- Network access to at least one Ethereum beacon node's HTTP API.

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

| Variable        | Default                                              | Description                                                                                 |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `NODE_ENDPOINT` | `127.0.0.1:5052,127.0.0.1:3500,127.0.0.1:5051`       | Comma-separated `host:port` list of beacon node HTTP endpoints. Checked in order; the first synced one is used. |
| `KEY_JSON_PATH` | `keys.json`                                          | Path to the JSON file containing the validator keys to check.                                |
| `CHUNK_SIZE`    | `500`                                                | Number of public keys queried per beacon API request.                                       |
| `WEBHOOK_URL`   | _(empty)_                                            | Microsoft Teams **Workflows** incoming webhook URL. If empty, the Teams notification is skipped. |

### Key file format

`KEY_JSON_PATH` must point to a JSON array of objects, each with at least a
`pubkey` field:

```json
[
  {
    "pubkey": "0xaf59776ab9eafa0c9524f1e76daafaa5666c8ea16e129274bcefa8c72d8d4ddd6e71f409b9da43a05ca4ea5d1033ebf3",
    "genIndex": 0
  }
]
```

## Usage

Run a full status check:

```bash
npm run check
# or
node index.js
```

Output is logged to the console and to `combined.log` / `error.log`, and a
detailed JSON report is written to the `results/` directory.

## Microsoft Teams integration

The summary is sent as an [Adaptive Card](https://adaptivecards.io/) to a
Teams channel.

> **Note:** Microsoft has retired the legacy **Office 365 Connector**
> webhooks. This app targets the newer **Workflows** (Power Automate)
> webhooks. Create one in Teams via
> *channel → Workflows → "Post to a channel when a webhook request is
> received"* and use the generated URL as `WEBHOOK_URL`.

The card uses Adaptive Card schema **1.5** (the maximum the Teams client
currently renders) and stringifies all values, since Teams `FactSet` fields
must be strings.

### Testing the webhook

To verify your `WEBHOOK_URL` is wired up correctly without running a full key
check, send a sample card:

```bash
npm run test:webhook
```

It posts a representative status card and exits `0` on success or `1` on
failure. A delivered message logs `Webhook delivered (HTTP 202)` — Teams
Workflows reply with `202 Accepted` and an empty body.

## Project layout

| File              | Purpose                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `index.js`        | Main entry point and all check/aggregation/webhook logic.         |
| `logger.js`       | Winston logger writing to the console, `combined.log`, `error.log`. |
| `test-webhook.js` | Standalone Teams webhook connectivity test.                       |
| `.env.example`    | Template for the supported environment variables.                 |
| `results/`        | Timestamped JSON reports from each run (git-ignored).             |

## Exit codes

- `0` — completed successfully.
- `1` — no synced beacon node available, no validator data returned, or
  (for `test:webhook`) the webhook send failed.

## License

MIT — see [LICENSE](./LICENSE).

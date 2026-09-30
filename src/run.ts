// run.ts - one complete check: load the key sets, find a synced node, build
// and write a report per set, post its cards.
//
// This is the former index.js main(). It returns whether the run succeeded
// instead of calling process.exit(), so the scheduler can keep going after a
// failed run; the --once CLI turns the result into the exit code.
import fs from 'node:fs';
import path from 'node:path';
import logger from './logger.js';
import { loadKeySets } from './keysets.js';
import { normalizePubkey, checkFullnodes, fetchValidators, fetchDepositQueue } from './beacon.js';
import { buildReport } from './status.js';
import { buildCards, getAdaptiveCard } from './cards.js';
import { loadRunConfig, type RunConfig } from './config.js';
import type { DepositQueue, KeyEntry, KeySet, Report, TeamsMessage, ValidatorMap } from './types.js';

const RESET = '\x1b[0m';
const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function postCard(message: TeamsMessage, url: string = loadRunConfig().webhookUrl): Promise<boolean> {
    if (!url) {
        logger.error('No Webhook URL');
        return false;
    }
    const body = JSON.stringify(message);
    const options: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
    };
    try {
        const response = await fetch(url, options);
        if (response.ok) {
            // Teams Workflows (Power Automate) reply with 202 Accepted and an
            // empty body before they try to render the card, so this confirms
            // receipt only - an oversized card is accepted and then dropped
            // without telling us. Hence the size in the log.
            logger.info(`Webhook accepted (HTTP ${response.status}, ${(body.length / 1024).toFixed(1)} KB)`);
            return true;
        }
        logger.error('Error calling webhook: ' + await response.text());
        return false;
    } catch (error) {
        logger.error('Error calling webhook: ' + String(error));
        return false;
    }
}

// Kept for callers that have a flat status object rather than a report.
export async function callWebhook(data: Record<string, unknown>, url?: string, title?: string): Promise<boolean> {
    return postCard(getAdaptiveCard(data, title), url);
}

function getTimestamp(): string {
    return new Date()
        .toISOString()            // e.g., "2024-12-27T14:35:10.123Z"
        .replace(/:/g, '-')       // replace colons with dashes
        .replace('T', '_')        // optional, replace the 'T' with an underscore
        .replace(/\.\d{3}Z$/, ''); // remove milliseconds and trailing 'Z'
}

async function writeResults(report: Report, resultsDir: string): Promise<void> {
    const data = JSON.stringify(report, null, 2);
    const writePath = path.join(resultsDir, `results-${report.slug}-${getTimestamp()}.json`);
    try {
        await fs.promises.mkdir(resultsDir, { recursive: true });
        await fs.promises.writeFile(writePath, data);
        logger.info('Results written to: ' + writePath);
    } catch {
        logger.error('Error writing file: ' + writePath);
    }
}

async function readJSONFile(file: string): Promise<unknown> {
    const data = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(data);
}

interface FetchedValidators {
    validators: ValidatorMap;
    endpoint: string;
}

// Walks the available nodes instead of giving up after the first one.
async function fetchValidatorsFromAny(nodes: string[], pubkeys: string[], chunkSize: number): Promise<FetchedValidators | null> {
    for (const node of nodes) {
        try {
            return { validators: await fetchValidators(node, pubkeys, chunkSize), endpoint: node };
        } catch (error) {
            logger.error('Error checking keys on ' + node + ': ' + errorMessage(error));
        }
    }
    return null;
}

export interface QueueCache {
    loaded: boolean;
    queue: DepositQueue | null;
}

// The queue is the same for every key set, and can be a large response, so
// it is fetched at most once per run.
async function getDepositQueue(nodes: string[], cache: QueueCache): Promise<DepositQueue | null> {
    if (cache.loaded) return cache.queue;
    cache.loaded = true;
    for (const node of nodes) {
        const queue = await fetchDepositQueue(node);
        if (queue) {
            cache.queue = queue;
            return queue;
        }
    }
    cache.queue = null;
    return null;
}

function keyIndex(key: { genIndex?: number; position?: number }): number | undefined {
    return key.genIndex !== undefined ? key.genIndex : key.position;
}

function logReport(report: Report): void {
    logger.info(GREEN + `Finished ${report.name}` + RESET);
    logger.info('Keys checked: ' + YELLOW + report.totals.keys + RESET);
    logger.info('Active (incl. queue): ' + YELLOW + report.totals.active + RESET);
    Object.keys(report.stateCounts).sort().forEach((state) => {
        logger.info('  ' + state + ': ' + YELLOW + report.stateCounts[state] + RESET);
    });
    if (report.type === 'cmv2') {
        logger.info('Total balance: ' + YELLOW + report.totals.balanceTotalEth.toFixed(2) + ' ETH' + RESET
            + ` (min ${report.totals.balanceMinEth.toFixed(2)} / avg ${report.totals.balanceAvgEth.toFixed(2)} / max ${report.totals.balanceMaxEth.toFixed(2)})`);
        if (report.totals.pendingTopUpEth > 0) {
            logger.info('Queued top-ups: ' + YELLOW + report.totals.pendingTopUpEth.toFixed(2) + ' ETH' + RESET);
        }
        const { lastDeposited, firstUndeposited, firstBelowCap, maxBalanceEth } = report.frontiers;
        if (lastDeposited >= 0) {
            const last = report.keys[lastDeposited];
            logger.info('Deposit frontier: last on chain #' + YELLOW + keyIndex(last) + RESET + ' (' + last.state + ')'
                + (firstUndeposited >= 0 ? ', next not deposited #' + YELLOW + keyIndex(report.keys[firstUndeposited]) + RESET : ', all keys deposited'));
        }
        if (firstBelowCap >= 0) {
            const key = report.keys[firstBelowCap];
            // A key only becomes the fill frontier if it has a balance.
            logger.info('Fill frontier: first key below ' + maxBalanceEth + ' ETH is #' + YELLOW + keyIndex(key) + RESET
                + ' at ' + YELLOW + key.balanceEth!.toFixed(2) + ' ETH' + RESET);
        }
    }
}

export async function processKeySet(
    keySet: KeySet,
    nodes: string[],
    queueCache: QueueCache,
    config: RunConfig = loadRunConfig()
): Promise<boolean> {
    logger.info(`--- ${keySet.name} (${keySet.type}) ---`);
    logger.info('Reading keys from file: ' + keySet.keyFile);

    let rawKeys: unknown;
    try {
        rawKeys = await readJSONFile(keySet.keyFile);
    } catch (error) {
        logger.error('Error reading file ' + keySet.keyFile + ': ' + errorMessage(error));
        return false;
    }
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
        logger.error(keySet.keyFile + ' contained no keys');
        return false;
    }
    const keys: KeyEntry[] = (rawKeys as KeyEntry[]).map(key => ({ ...key, pubkey: normalizePubkey(key.pubkey) }));

    logger.info('Checking ' + keys.length + ' keys');
    const fetched = await fetchValidatorsFromAny(nodes, keys.map(k => k.pubkey), keySet.chunkSize);
    if (!fetched) {
        logger.error('No Validator Data for ' + keySet.name);
        return false;
    }

    const missing = keys.filter(key => !fetched.validators.has(key.pubkey)).length;
    // cmv2 keys are 0x02 and may have top-ups waiting in the same queue, so
    // the queue is always relevant there - not only when keys are missing.
    let queue: DepositQueue | null = null;
    if (missing > 0 || keySet.type === 'cmv2') {
        if (missing > 0) {
            logger.info(missing + ' key(s) have no validator record - checking the deposit queue');
        }
        queue = await getDepositQueue(nodes, queueCache);
    }

    const report = buildReport(keySet, keys, fetched.validators, queue, {
        endpoint: fetched.endpoint,
        churnEthPerEpoch: config.churnEthPerEpoch,
        maxBalanceEth: config.maxBalanceEth
    });

    logReport(report);
    await writeResults(report, config.resultsDir);

    const cards = buildCards(report, {
        maxBytes: config.maxCardBytes,
        maxFacts: config.maxFactsPerCard,
        frontierWindow: config.frontierWindow
    });
    if (cards.length > 1) {
        logger.info(`Posting ${cards.length} cards for ${report.name}: a summary card plus ${cards.length - 1} card(s) of per-key rows`);
    }
    let delivered = true;
    for (let i = 0; i < cards.length; i++) {
        if (i > 0) await sleep(config.webhookDelayMs);
        delivered = await postCard(cards[i], keySet.webhookUrl) && delivered;
    }
    return delivered;
}

async function runUnguarded(config: RunConfig): Promise<boolean> {
    logger.info('Start Checking Keys');

    // Re-read on every run, so keysets.json edits need no restart.
    let keySets: KeySet[];
    try {
        keySets = loadKeySets();
    } catch (error) {
        logger.error(errorMessage(error));
        return false;
    }

    logger.info('Check configured Fullnodes');
    const nodes = await checkFullnodes(config.nodeEndpoints, { RESET, RED, GREEN });
    if (nodes.length === 0) {
        logger.error('No available Fullnodes');
        return false;
    }

    const queueCache: QueueCache = { loaded: false, queue: null };
    let allOk = true;
    for (const keySet of keySets) {
        const ok = await processKeySet(keySet, nodes, queueCache, config);
        allOk = ok && allOk;
    }

    logger.info(allOk ? GREEN + 'Finished Checking Keys' + RESET : RED + 'Finished with errors' + RESET);
    return allOk;
}

// Resolves true when every key set produced a report and delivered its
// cards. Never rejects: anything unexpected is logged and counts as a failed
// run, so a long-running scheduler survives it.
export async function run(config: RunConfig = loadRunConfig()): Promise<boolean> {
    try {
        return await runUnguarded(config);
    } catch (error) {
        logger.error('Unexpected error during the key check: ' + (error instanceof Error && error.stack ? error.stack : String(error)));
        return false;
    }
}

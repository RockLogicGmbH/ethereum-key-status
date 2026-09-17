require('dotenv').config();
const logger = require('./logger');
const fs = require('fs');
const path = require('path');
const { loadKeySets } = require('./keysets');
const { normalizePubkey, checkFullnodes, fetchValidators, fetchDepositQueue } = require('./beacon');
const { buildReport } = require('./status');
const { buildCards, getAdaptiveCard, DEFAULT_MAX_CARD_BYTES, DEFAULT_MAX_FACTS_PER_CARD, DEFAULT_FRONTIER_WINDOW } = require('./cards');

const NODE_ENDPOINT = process.env.NODE_ENDPOINT || '127.0.0.1:5052,127.0.0.1:3500,127.0.0.1:5051';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
// Mainnet caps the per-epoch deposit churn at 256 ETH, which is what the
// queue wait estimate is based on.
const CHURN_ETH_PER_EPOCH = parseFloat(process.env.DEPOSIT_CHURN_ETH_PER_EPOCH) || 256;
const MAX_CARD_BYTES = parseInt(process.env.MAX_CARD_BYTES, 10) || DEFAULT_MAX_CARD_BYTES;
const MAX_FACTS_PER_CARD = parseInt(process.env.MAX_FACTS_PER_CARD, 10) || DEFAULT_MAX_FACTS_PER_CARD;
const FRONTIER_WINDOW = parseInt(process.env.FRONTIER_WINDOW, 10) || DEFAULT_FRONTIER_WINDOW;
// EIP-7251 compounding cap: the balance a 0x02 key fills up to.
const MAX_BALANCE_ETH = parseFloat(process.env.CMV2_MAX_BALANCE_ETH) || 2048;
const WEBHOOK_DELAY_MS = parseInt(process.env.WEBHOOK_DELAY_MS, 10) || 500;

const RESET = '\x1b[0m';
const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function postCard(message, url = WEBHOOK_URL) {
    if (!url) {
        logger.error('No Webhook URL');
        return false;
    }
    const body = JSON.stringify(message);
    const options = {
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
        logger.error('Error calling webhook: ' + error);
        return false;
    }
}

// Kept for callers that have a flat status object rather than a report.
async function callWebhook(data, url = WEBHOOK_URL, title) {
    return postCard(getAdaptiveCard(data, title), url);
}

function getTimestamp() {
    return new Date()
        .toISOString()            // e.g., "2024-12-27T14:35:10.123Z"
        .replace(/:/g, '-')       // replace colons with dashes
        .replace('T', '_')        // optional, replace the 'T' with an underscore
        .replace(/\.\d{3}Z$/, ''); // remove milliseconds and trailing 'Z'
}

async function writeResults(report) {
    const data = JSON.stringify(report, null, 2);
    const writePath = path.join(__dirname, 'results', `results-${report.slug}-${getTimestamp()}.json`);
    try {
        await fs.promises.mkdir(path.join(__dirname, 'results'), { recursive: true });
        await fs.promises.writeFile(writePath, data);
        logger.info('Results written to: ' + writePath);
    } catch (error) {
        logger.error('Error writing file: ' + writePath);
    }
}

async function readJSONFile(file) {
    const data = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(data);
}

// Walks the available nodes instead of giving up after the first one.
async function fetchValidatorsFromAny(nodes, pubkeys, chunkSize) {
    for (const node of nodes) {
        try {
            return { validators: await fetchValidators(node, pubkeys, chunkSize), endpoint: node };
        } catch (error) {
            logger.error('Error checking keys on ' + node + ': ' + error.message);
        }
    }
    return null;
}

// The queue is the same for every key set, and can be a large response, so
// it is fetched at most once per run.
async function getDepositQueue(nodes, cache) {
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

function keyIndex(key) {
    return key.genIndex !== undefined ? key.genIndex : key.position;
}

function logReport(report) {
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
            logger.info('Fill frontier: first key below ' + maxBalanceEth + ' ETH is #' + YELLOW + keyIndex(key) + RESET
                + ' at ' + YELLOW + key.balanceEth.toFixed(2) + ' ETH' + RESET);
        }
    }
}

async function processKeySet(keySet, nodes, queueCache) {
    logger.info(`--- ${keySet.name} (${keySet.type}) ---`);
    logger.info('Reading keys from file: ' + keySet.keyFile);

    let rawKeys;
    try {
        rawKeys = await readJSONFile(keySet.keyFile);
    } catch (error) {
        logger.error('Error reading file ' + keySet.keyFile + ': ' + error.message);
        return false;
    }
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
        logger.error(keySet.keyFile + ' contained no keys');
        return false;
    }
    const keys = rawKeys.map(key => ({ ...key, pubkey: normalizePubkey(key.pubkey) }));

    logger.info('Checking ' + keys.length + ' keys');
    const fetched = await fetchValidatorsFromAny(nodes, keys.map(k => k.pubkey), keySet.chunkSize);
    if (!fetched) {
        logger.error('No Validator Data for ' + keySet.name);
        return false;
    }

    const missing = keys.filter(key => !fetched.validators.has(key.pubkey)).length;
    // cmv2 keys are 0x02 and may have top-ups waiting in the same queue, so
    // the queue is always relevant there - not only when keys are missing.
    let queue = null;
    if (missing > 0 || keySet.type === 'cmv2') {
        if (missing > 0) {
            logger.info(missing + ' key(s) have no validator record - checking the deposit queue');
        }
        queue = await getDepositQueue(nodes, queueCache);
    }

    const report = buildReport(keySet, keys, fetched.validators, queue, {
        endpoint: fetched.endpoint,
        churnEthPerEpoch: CHURN_ETH_PER_EPOCH,
        maxBalanceEth: MAX_BALANCE_ETH
    });

    logReport(report);
    await writeResults(report);

    const cards = buildCards(report, {
        maxBytes: MAX_CARD_BYTES,
        maxFacts: MAX_FACTS_PER_CARD,
        frontierWindow: FRONTIER_WINDOW
    });
    if (cards.length > 1) {
        logger.info(`Posting ${cards.length} cards for ${report.name}: a summary card plus ${cards.length - 1} card(s) of per-key rows`);
    }
    let delivered = true;
    for (let i = 0; i < cards.length; i++) {
        if (i > 0) await sleep(WEBHOOK_DELAY_MS);
        delivered = await postCard(cards[i], keySet.webhookUrl) && delivered;
    }
    return delivered;
}

async function main() {
    logger.info('Start Checking Keys');

    let keySets;
    try {
        keySets = loadKeySets();
    } catch (error) {
        logger.error(error.message);
        process.exit(1);
    }

    logger.info('Check configured Fullnodes');
    const nodes = await checkFullnodes(NODE_ENDPOINT.split(','), { RESET, RED, GREEN });
    if (nodes.length === 0) {
        logger.error('No available Fullnodes');
        process.exit(1);
    }

    const queueCache = { loaded: false, queue: null };
    let allOk = true;
    for (const keySet of keySets) {
        const ok = await processKeySet(keySet, nodes, queueCache);
        allOk = ok && allOk;
    }

    logger.info(allOk ? GREEN + 'Finished Checking Keys' + RESET : RED + 'Finished with errors' + RESET);
    if (!allOk) process.exit(1);
}

if (require.main === module) {
    main();
}

module.exports = { main, callWebhook, postCard, getAdaptiveCard, processKeySet };

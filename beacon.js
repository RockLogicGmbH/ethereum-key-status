// beacon.js — access to the Ethereum beacon (consensus) node HTTP API.
const logger = require('./logger');

const GWEI_PER_ETH = 1e9;
const SECONDS_PER_EPOCH = 32 * 12; // 384s

// Normalise a pubkey so key-file input and API responses compare equal.
function normalizePubkey(pubkey) {
    const hex = String(pubkey).trim().toLowerCase();
    return hex.startsWith('0x') ? hex : '0x' + hex;
}

function gweiToEth(gwei) {
    return Number(gwei) / GWEI_PER_ETH;
}

// Returns the endpoints that are reachable and fully synced, in the order
// they were configured.
async function checkFullnodes(endpoints, colors = {}) {
    const { RESET = '', RED = '', GREEN = '' } = colors;
    const available = [];
    for (const node of endpoints) {
        try {
            const response = await fetch(`http://${node}/eth/v1/node/syncing`);
            const json = await response.json();
            logger.info('Fullnode ' + node + ' is ' + (json.data.is_syncing ? `${RED}syncing${RESET}` : `${GREEN}not syncing${RESET}`) + ` (${json.data.sync_distance})`);
            if (!json.data.is_syncing)
                available.push(node);
        } catch (error) {
            logger.error('Error connecting to Fullnode ' + node);
        }
    }
    return available;
}

// Single request for every pubkey. Avoids the very long query strings a
// GET with hundreds of 98-character pubkeys produces, which some clients
// reject outright. Not every client implements it, hence the GET fallback.
async function fetchValidatorsPost(endpoint, pubkeys) {
    const url = `http://${endpoint}/eth/v1/beacon/states/head/validators`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: pubkeys })
    });
    if (!response.ok) {
        throw new Error(`POST validators returned HTTP ${response.status}`);
    }
    const json = await response.json();
    if (!json.data || !Array.isArray(json.data)) {
        throw new Error('POST validators returned no data array');
    }
    return json.data;
}

async function fetchValidatorsGet(endpoint, pubkeys, chunkSize) {
    let data = [];
    for (let i = 0; i < pubkeys.length; i += chunkSize) {
        const chunk = pubkeys.slice(i, i + chunkSize);
        const url = `http://${endpoint}/eth/v1/beacon/states/head/validators?id=${chunk.join()}`;
        const response = await fetch(url);
        const json = await response.json();
        if (!json.data || !Array.isArray(json.data)) {
            logger.error('Response: ' + JSON.stringify(json, null, 2));
            throw new Error('GET validators returned no data array');
        }
        data = data.concat(json.data);
        logger.info('Finished Batch ' + i + ' - ' + (i + chunkSize));
    }
    return data;
}

// Queries the validator set for `pubkeys` and returns a Map keyed by pubkey.
// Keys the beacon chain does not know about are simply absent from the map —
// the API omits unknown ids rather than erroring.
async function fetchValidators(endpoint, pubkeys, chunkSize) {
    let data;
    try {
        data = await fetchValidatorsPost(endpoint, pubkeys);
        logger.info(`Fetched ${data.length} validator records from ${endpoint} in one POST request`);
    } catch (error) {
        logger.warn(`POST /validators unavailable on ${endpoint} (${error.message}); falling back to chunked GET`);
        data = await fetchValidatorsGet(endpoint, pubkeys, chunkSize);
    }
    const byPubkey = new Map();
    for (const entry of data) {
        byPubkey.set(normalizePubkey(entry.validator.pubkey), entry);
    }
    return byPubkey;
}

// The Electra pending-deposit queue: deposits already made on the execution
// chain that the beacon chain has not processed yet. A key sitting here has
// no validator record at all, so it is invisible to /validators — and it can
// stay here for weeks when the queue is long.
async function fetchDepositQueue(endpoint) {
    const url = `http://${endpoint}/eth/v1/beacon/states/head/pending_deposits`;
    let json;
    try {
        const response = await fetch(url);
        if (!response.ok) {
            logger.warn(`Deposit queue unavailable on ${endpoint} (HTTP ${response.status}) — keys without a validator record cannot be told apart from undeposited ones`);
            return null;
        }
        json = await response.json();
    } catch (error) {
        logger.warn(`Error reading deposit queue from ${endpoint}: ${error}`);
        return null;
    }
    if (!json.data || !Array.isArray(json.data)) {
        logger.warn(`Deposit queue response from ${endpoint} had no data array`);
        return null;
    }

    // Entries are in queue order, so the ETH ahead of a given entry is the
    // running total of everything before it.
    const byPubkey = new Map();
    let gweiSoFar = 0;
    json.data.forEach((deposit, position) => {
        const pubkey = normalizePubkey(deposit.pubkey);
        const amount = Number(deposit.amount);
        const existing = byPubkey.get(pubkey);
        if (existing) {
            existing.amountGwei += amount;
            existing.deposits += 1;
        } else {
            byPubkey.set(pubkey, {
                position,
                gweiAhead: gweiSoFar,
                amountGwei: amount,
                deposits: 1,
                slot: Number(deposit.slot)
            });
        }
        gweiSoFar += amount;
    });

    logger.info(`Deposit queue: ${json.data.length} pending deposits, ${gweiToEth(gweiSoFar).toFixed(0)} ETH total`);
    return { byPubkey, length: json.data.length, totalGwei: gweiSoFar };
}

// Rough time until the queue drains far enough for this deposit to be
// processed. The per-epoch churn is capped at 256 ETH on mainnet, so the
// default is right in practice, but activation adds further delay on top.
function estimateQueueWaitSeconds(gweiAhead, churnEthPerEpoch) {
    const epochs = gweiToEth(gweiAhead) / churnEthPerEpoch;
    return epochs * SECONDS_PER_EPOCH;
}

module.exports = {
    GWEI_PER_ETH,
    normalizePubkey,
    gweiToEth,
    checkFullnodes,
    fetchValidators,
    fetchDepositQueue,
    estimateQueueWaitSeconds
};

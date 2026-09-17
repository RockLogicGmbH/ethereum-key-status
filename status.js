// status.js — turns raw beacon data into the per-key-set report.
const { gweiToEth, estimateQueueWaitSeconds } = require('./beacon');

// Deposited on the execution chain but not yet processed by the beacon
// chain: no validator record exists, yet the key is committed and counts
// towards the operator's active keys.
const IN_DEPOSIT_QUEUE = 'in_deposit_queue';
// In the key file, but neither a validator nor a queued deposit.
const NOT_DEPOSITED = 'not_deposited';
// Same as above, but the node could not tell us about the queue.
const UNKNOWN = 'unknown';

function isActiveState(state) {
    return state.startsWith('active_') || state.startsWith('pending_') || state === IN_DEPOSIT_QUEUE;
}

function credentialsType(withdrawalCredentials) {
    return withdrawalCredentials ? withdrawalCredentials.slice(0, 4) : null;
}

function buildKeyReport(key, validator, queued, options) {
    const { churnEthPerEpoch } = options;
    const report = {
        pubkey: key.pubkey,
        genIndex: key.genIndex,
        state: UNKNOWN
    };

    if (validator) {
        report.state = validator.status;
        report.validatorIndex = Number(validator.index);
        report.balanceEth = gweiToEth(validator.balance);
        report.effectiveBalanceEth = gweiToEth(validator.validator.effective_balance);
        report.credentials = credentialsType(validator.validator.withdrawal_credentials);
        // 0x02 validators accept top-ups towards the 2048 ETH cap; those go
        // through the same queue, so an active key can have one pending.
        if (queued) {
            report.pendingTopUpEth = gweiToEth(queued.amountGwei);
        }
        return report;
    }

    if (queued) {
        report.state = IN_DEPOSIT_QUEUE;
        report.balanceEth = gweiToEth(queued.amountGwei);
        report.credentials = null;
        report.queue = {
            position: queued.position,
            ethAhead: gweiToEth(queued.gweiAhead),
            estimatedWaitSeconds: estimateQueueWaitSeconds(queued.gweiAhead, churnEthPerEpoch)
        };
        return report;
    }

    report.state = options.queueKnown ? NOT_DEPOSITED : UNKNOWN;
    return report;
}

// The two boundaries worth watching on a cmv2 set, both expressed as
// positions in the key file:
//
//  - the deposit frontier: the last key that made it onto the chain (active
//    or still queued) and the first one behind it that has not been
//    deposited at all, i.e. how far down the key list deposits have reached;
//  - the fill frontier: the first key still below the 2048 ETH compounding
//    cap, i.e. where the next top-up lands.
function computeFrontiers(keys, maxBalanceEth) {
    const isOnChain = key => key.state !== NOT_DEPOSITED && key.state !== UNKNOWN;

    let lastDeposited = -1;
    for (let i = keys.length - 1; i >= 0; i--) {
        if (isOnChain(keys[i])) {
            lastDeposited = i;
            break;
        }
    }
    const firstUndeposited = lastDeposited + 1 < keys.length ? lastDeposited + 1 : -1;

    let firstBelowCap = -1;
    for (let i = 0; i < keys.length; i++) {
        // Only keys with a validator record can take a top-up.
        if (keys[i].validatorIndex !== undefined && keys[i].balanceEth < maxBalanceEth) {
            firstBelowCap = i;
            break;
        }
    }

    return {
        lastDeposited,
        firstUndeposited,
        firstBelowCap,
        maxBalanceEth,
        hasActiveKeys: keys.some(key => key.validatorIndex !== undefined)
    };
}

function buildReport(keySet, keys, validators, queue, options) {
    const churnEthPerEpoch = options.churnEthPerEpoch;
    const queueKnown = queue !== null;
    const keyReports = keys.map((key, i) => {
        const validator = validators.get(key.pubkey);
        const queued = queueKnown ? queue.byPubkey.get(key.pubkey) : undefined;
        const report = buildKeyReport(key, validator, queued, { churnEthPerEpoch, queueKnown });
        report.position = i;
        if (keySet.reportBatches) {
            const start = Math.floor(i / keySet.chunkSize) * keySet.chunkSize;
            report.batch = `${start}-${start + keySet.chunkSize}`;
        }
        return report;
    });

    const stateCounts = {};
    const batches = {};
    const credentials = {};
    let balanceTotalEth = 0;
    let pendingTopUpEth = 0;
    let balanceMinEth = null;
    let balanceMaxEth = null;
    let balancedKeys = 0;

    for (const key of keyReports) {
        stateCounts[key.state] = (stateCounts[key.state] || 0) + 1;
        if (key.batch !== undefined) {
            batches[key.batch] = batches[key.batch] || 0;
            if (key.state === 'active_ongoing') batches[key.batch] += 1;
        }
        if (key.credentials) {
            credentials[key.credentials] = (credentials[key.credentials] || 0) + 1;
        }
        if (typeof key.balanceEth === 'number') {
            balanceTotalEth += key.balanceEth;
            balancedKeys += 1;
            if (balanceMinEth === null || key.balanceEth < balanceMinEth) balanceMinEth = key.balanceEth;
            if (balanceMaxEth === null || key.balanceEth > balanceMaxEth) balanceMaxEth = key.balanceEth;
        }
        if (typeof key.pendingTopUpEth === 'number') {
            pendingTopUpEth += key.pendingTopUpEth;
        }
    }

    const activeCount = Object.entries(stateCounts)
        .filter(([state]) => isActiveState(state))
        .reduce((sum, [, count]) => sum + count, 0);

    return {
        name: keySet.name,
        slug: keySet.slug,
        type: keySet.type,
        perKeyCard: keySet.perKeyCard,
        keyFile: keySet.keyFile,
        endpoint: options.endpoint,
        checkedAt: new Date().toISOString(),
        totals: {
            keys: keyReports.length,
            // Everything the operator is committed to: live validators,
            // validators awaiting activation, and deposits still in the queue.
            active: activeCount,
            balanceTotalEth,
            balanceAvgEth: balancedKeys ? balanceTotalEth / balancedKeys : 0,
            balanceMinEth: balanceMinEth === null ? 0 : balanceMinEth,
            balanceMaxEth: balanceMaxEth === null ? 0 : balanceMaxEth,
            pendingTopUpEth
        },
        stateCounts,
        credentials,
        frontiers: computeFrontiers(keyReports, options.maxBalanceEth),
        batches: keySet.reportBatches ? batches : undefined,
        keys: keyReports
    };
}

module.exports = { buildReport, computeFrontiers, isActiveState, IN_DEPOSIT_QUEUE, NOT_DEPOSITED, UNKNOWN };

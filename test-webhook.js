require('dotenv').config();
const logger = require('./logger');
const { postCard } = require('./index');
const { buildCards } = require('./cards');
const { computeFrontiers } = require('./status');

// Representative reports, matching the shape buildReport() produces in
// status.js, so the rendered Adaptive Cards look like a real run.
const cmv1Report = {
    name: 'Lido CSM v1 (test)',
    type: 'cmv1',
    perKeyCard: false,
    totals: { keys: 1249, active: 1234 },
    stateCounts: { active_ongoing: 1234, withdrawal_possible: 12, withdrawal_done: 3 },
    credentials: { '0x01': 1249 },
    batches: { '0-500': 500, '500-1000': 500, '1000-1500': 234 },
    keys: []
};

const cmv2Keys = [
    { pubkey: '0xaf59776ab9eafa0c9524f1e76daafaa5666c8ea16e129274bcefa8c72d8d4ddd6e71f409b9da43a05ca4ea5d1033ebf3', genIndex: 0, position: 0, state: 'active_ongoing', balanceEth: 2048, credentials: '0x02', validatorIndex: 500000 },
    { pubkey: '0xb1c2d3e4f5a6978877665544332211009988776655443322110099887766554433221100998877665544332211009988', genIndex: 1, position: 1, state: 'active_ongoing', balanceEth: 1056.42, credentials: '0x02', pendingTopUpEth: 256, validatorIndex: 500001 },
    { pubkey: '0xc2d3e4f5a697887766554433221100998877665544332211009988776655443322110099887766554433221100998877', genIndex: 2, position: 2, state: 'active_ongoing', balanceEth: 32, credentials: '0x01', validatorIndex: 500002 },
    { pubkey: '0xd3e4f5a69788776655443322110099887766554433221100998877665544332211009988776655443322110099887766', genIndex: 3, position: 3, state: 'in_deposit_queue', balanceEth: 32, queue: { position: 48213, ethAhead: 1542816, estimatedWaitSeconds: 3456000 } },
    { pubkey: '0xe4f5a6978877665544332211009988776655443322110099887766554433221100998877665544332211009988776655', genIndex: 4, position: 4, state: 'not_deposited' }
];

const cmv2Report = {
    name: 'Lido CSM v2 (test)',
    type: 'cmv2',
    perKeyCard: false,
    totals: {
        keys: 5, active: 4,
        balanceTotalEth: 3168.42, balanceAvgEth: 792.11,
        balanceMinEth: 32, balanceMaxEth: 2048, pendingTopUpEth: 256
    },
    stateCounts: { active_ongoing: 3, in_deposit_queue: 1, not_deposited: 1 },
    credentials: { '0x02': 2, '0x01': 1 },
    frontiers: computeFrontiers(cmv2Keys, 2048),
    keys: cmv2Keys
};

async function main() {
    const cards = [...buildCards(cmv1Report), ...buildCards(cmv2Report)];
    logger.info(`Sending ${cards.length} test card(s) to the Teams webhook...`);
    let ok = true;
    for (const card of cards) {
        ok = await postCard(card) && ok;
    }
    if (ok) {
        logger.info('Webhook test succeeded — check the Teams channel for the cards.');
        process.exit(0);
    }
    logger.error('Webhook test failed — see the error above.');
    process.exit(1);
}

main();

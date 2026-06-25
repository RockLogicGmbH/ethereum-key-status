require('dotenv').config();
const logger = require('./logger');
const { callWebhook } = require('./index');

// A representative status payload, matching the shape produced by getStatus()
// in index.js, so the rendered Adaptive Card looks like a real run.
const sampleStatus = {
    test: 'webhook connectivity check',
    active_ongoing: 1234,
    withdrawal_possible: 12,
    withdrawal_done: 3,
    '0-500': 500,
    '500-1000': 500,
    '1000-1500': 249,
};

async function main() {
    logger.info('Sending test message to Teams webhook...');
    const ok = await callWebhook(sampleStatus);
    if (ok) {
        logger.info('Webhook test succeeded — check the Teams channel for the card.');
        process.exit(0);
    } else {
        logger.error('Webhook test failed — see the error above.');
        process.exit(1);
    }
}

main();

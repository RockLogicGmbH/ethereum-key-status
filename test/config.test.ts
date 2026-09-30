import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_NODE_ENDPOINT, DEFAULT_SCHEDULE, loadRunConfig, loadSchedulerConfig } from '../src/config.js';
import { heartbeatFile } from '../src/heartbeat.js';

describe('loadRunConfig', () => {
    it('uses the documented defaults', () => {
        assert.deepEqual(loadRunConfig({}), {
            nodeEndpoints: DEFAULT_NODE_ENDPOINT.split(','),
            webhookUrl: '',
            churnEthPerEpoch: 256,
            maxCardBytes: 16000,
            maxFactsPerCard: 100,
            frontierWindow: 2,
            maxBalanceEth: 2048,
            webhookDelayMs: 500,
            resultsDir: path.resolve('results')
        });
    });

    it('reads overrides, falling back on empty, invalid or zero values', () => {
        const c = loadRunConfig({ NODE_ENDPOINT: 'a:1,b:2', DEPOSIT_CHURN_ETH_PER_EPOCH: '128.5', MAX_CARD_BYTES: '0', MAX_FACTS_PER_CARD: 'x', FRONTIER_WINDOW: '3', CMV2_MAX_BALANCE_ETH: '', WEBHOOK_DELAY_MS: '10', RESULTS_DIR: '/data/results' });
        assert.deepEqual(c.nodeEndpoints, ['a:1', 'b:2']);
        assert.equal(c.churnEthPerEpoch, 128.5);
        assert.equal(c.maxCardBytes, 16000);
        assert.equal(c.maxFactsPerCard, 100);
        assert.equal(c.frontierWindow, 3);
        assert.equal(c.maxBalanceEth, 2048);
        assert.equal(c.webhookDelayMs, 10);
        assert.equal(c.resultsDir, '/data/results');
    });
});

describe('loadSchedulerConfig', () => {
    it('defaults to the start of every quarter in local time', () => {
        assert.deepEqual(loadSchedulerConfig({}), { schedule: DEFAULT_SCHEDULE, timezone: undefined, runOnStart: false, heartbeatFile: path.join(os.tmpdir(), 'keystatus.heartbeat') });
        assert.equal(DEFAULT_SCHEDULE, '0 0 1 */3 *');
    });

    it('parses overrides', () => {
        const c = loadSchedulerConfig({ SCHEDULE: ' */5 * * * * ', SCHEDULE_TIMEZONE: 'Europe/Vienna', RUN_ON_START: 'TRUE', HEARTBEAT_FILE: '' });
        assert.deepEqual(c, { schedule: '*/5 * * * *', timezone: 'Europe/Vienna', runOnStart: true, heartbeatFile: undefined });
        for (const v of ['1', 'yes', 'on', 'true']) assert.equal(loadSchedulerConfig({ RUN_ON_START: v }).runOnStart, true);
        for (const v of ['0', 'no', 'false', '']) assert.equal(loadSchedulerConfig({ RUN_ON_START: v }).runOnStart, false);
        assert.equal(heartbeatFile({ HEARTBEAT_FILE: '/x/hb' }), '/x/hb');
    });
});

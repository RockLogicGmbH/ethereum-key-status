import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, computeFrontiers, isActiveState, IN_DEPOSIT_QUEUE, NOT_DEPOSITED, UNKNOWN } from '../src/status.js';
import { cmv1Batches, cmv1SmallPerKey, cmv2AllAtCap, cmv2Frontiers, cmv2NoneDeposited, perKeyCard500, unknownQueue } from './fixtures.js';
import { prepare, reportFor, REPORT_OPTIONS } from './helpers.js';

describe('isActiveState', () => {
    it('counts active_*, pending_* and queued deposits as committed', () => {
        for (const s of ['active_ongoing', 'active_exiting', 'active_slashed', 'pending_initialized', 'pending_queued', IN_DEPOSIT_QUEUE]) {
            assert.equal(isActiveState(s), true, s);
        }
        for (const s of ['exited_unslashed', 'withdrawal_possible', 'withdrawal_done', NOT_DEPOSITED, UNKNOWN]) {
            assert.equal(isActiveState(s), false, s);
        }
    });
});

describe('buildReport', () => {
    it('reports cmv1 batches, counting only active_ongoing per batch', async () => {
        const report = await reportFor(cmv1Batches());
        assert.equal(report.totals.keys, 1200);
        assert.deepEqual(Object.keys(report.batches!), ['0-500', '500-1000', '1000-1500']);
        const perBatch = { '0-500': 0, '500-1000': 0, '1000-1500': 0 } as Record<string, number>;
        for (const key of report.keys) if (key.state === 'active_ongoing') perBatch[key.batch!] += 1;
        assert.deepEqual(report.batches, perBatch);
        assert.equal(report.keys[499].batch, '0-500');
        assert.equal(report.keys[500].batch, '500-1000');
        assert.equal(report.stateCounts[IN_DEPOSIT_QUEUE], 10);
        assert.equal(report.stateCounts[NOT_DEPOSITED], 10);
        assert.equal(report.stateCounts.pending_queued, 10);
        // Active: everything except withdrawal_done and not_deposited.
        assert.equal(report.totals.active, 1200 - report.stateCounts.withdrawal_done - 10);
    });

    it('describes a queued deposit with its position, ETH ahead and wait', async () => {
        const report = await reportFor(cmv1Batches());
        const queued = report.keys[1180];
        assert.equal(queued.state, IN_DEPOSIT_QUEUE);
        assert.equal(queued.credentials, null);
        assert.equal(queued.balanceEth, 32);
        // 40 noise deposits ahead: 14 of 1 ETH and 26 of 32 ETH.
        assert.equal(queued.queue!.position, 40);
        assert.equal(queued.queue!.ethAhead, 14 * 1 + 26 * 32);
        assert.equal(queued.queue!.estimatedWaitSeconds, ((14 + 26 * 32) / 256) * 384);
        assert.equal(queued.validatorIndex, undefined);
    });

    it('keeps the field order and shape of the JSON report', async () => {
        const report = await reportFor(cmv2Frontiers());
        assert.deepEqual(Object.keys(report), ['name', 'slug', 'type', 'perKeyCard', 'keyFile', 'endpoint', 'checkedAt', 'totals', 'stateCounts', 'credentials', 'frontiers', 'batches', 'keys']);
        assert.equal(report.batches, undefined);
        assert.equal('batches' in JSON.parse(JSON.stringify(report)), false);
        assert.deepEqual(Object.keys(report.totals), ['keys', 'active', 'balanceTotalEth', 'balanceAvgEth', 'balanceMinEth', 'balanceMaxEth', 'pendingTopUpEth']);
        assert.deepEqual(Object.keys(report.keys[3]), ['pubkey', 'genIndex', 'state', 'validatorIndex', 'balanceEth', 'effectiveBalanceEth', 'credentials', 'pendingTopUpEth', 'position']);
        assert.deepEqual(Object.keys(report.keys[10]), ['pubkey', 'genIndex', 'state', 'balanceEth', 'credentials', 'queue', 'position']);
        assert.deepEqual(Object.keys(report.keys[15]), ['pubkey', 'genIndex', 'state', 'position']);
        assert.match(report.checkedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        assert.equal(report.endpoint, 'node:5052');
    });

    it('sums balances and queued top-ups on cmv2 and splits credentials', async () => {
        const report = await reportFor(cmv2Frontiers());
        const top = report.keys[3];
        assert.equal(top.pendingTopUpEth, 320);
        assert.equal(report.totals.pendingTopUpEth, 320);
        assert.deepEqual(report.credentials, { '0x02': 9, '0x01': 1 });
        assert.equal(report.totals.active, 13);
        assert.equal(report.totals.balanceMaxEth, 2048.004);
        assert.equal(report.totals.balanceMinEth, 32);
        // 10 validators plus 3 queued deposits have a balance.
        const balances = report.keys.filter(k => typeof k.balanceEth === 'number').map(k => k.balanceEth!);
        assert.equal(balances.length, 13);
        assert.equal(report.totals.balanceTotalEth, balances.reduce((a, b) => a + b, 0));
        assert.equal(report.totals.balanceAvgEth, report.totals.balanceTotalEth / 13);
    });

    it('marks keys unknown (not "not deposited") when the queue is unavailable', async () => {
        const s = unknownQueue();
        const p = await prepare(s);
        assert.equal(p.queue, null);
        const report = buildReport(s.keySet, p.keys, p.validators, p.queue, REPORT_OPTIONS);
        assert.deepEqual(report.stateCounts, { active_ongoing: 5, unknown: 3 });
        assert.equal(report.totals.active, 5);
        assert.equal(report.frontiers.lastDeposited, 4);
        assert.equal(report.frontiers.firstUndeposited, 5);
    });

    it('uses zero statistics when no key has a balance', async () => {
        const report = await reportFor(cmv2NoneDeposited());
        assert.deepEqual(report.totals, { keys: 4, active: 0, balanceTotalEth: 0, balanceAvgEth: 0, balanceMinEth: 0, balanceMaxEth: 0, pendingTopUpEth: 0 });
        assert.equal(report.keys[0].genIndex, undefined);
        assert.equal(report.name, 'CMv2 empty');
        assert.equal(report.keyFile, '/data/empty.json');
    });

    it('honours per-set chunkSize, reportBatches and normalised pubkeys', async () => {
        const report = await reportFor(cmv1SmallPerKey());
        assert.equal(report.slug, 'small');
        assert.deepEqual(report.batches, { '0-5': 4, '5-10': 5, '10-15': 0 });
        assert.equal(report.keys[0].state, 'active_ongoing');
        assert.ok(report.keys[0].pubkey.startsWith('0x'));
        assert.equal(report.keys[0].pubkey, report.keys[0].pubkey.toLowerCase());
    });

    it('counts 500 perKeyCard keys', async () => {
        const report = await reportFor(perKeyCard500());
        assert.equal(report.perKeyCard, true);
        assert.deepEqual(report.stateCounts, { active_ongoing: 120, in_deposit_queue: 130, not_deposited: 250 });
        assert.equal(report.totals.active, 250);
    });
});

describe('computeFrontiers', () => {
    it('finds both frontiers mid-list', async () => {
        const report = await reportFor(cmv2Frontiers());
        assert.deepEqual(report.frontiers, { lastDeposited: 12, firstUndeposited: 13, firstBelowCap: 3, maxBalanceEth: 2048, hasActiveKeys: true });
    });

    it('handles all-deposited-and-full and nothing-deposited sets', async () => {
        assert.deepEqual((await reportFor(cmv2AllAtCap())).frontiers, { lastDeposited: 5, firstUndeposited: -1, firstBelowCap: -1, maxBalanceEth: 2048, hasActiveKeys: true });
        assert.deepEqual((await reportFor(cmv2NoneDeposited())).frontiers, { lastDeposited: -1, firstUndeposited: 0, firstBelowCap: -1, maxBalanceEth: 2048, hasActiveKeys: false });
    });

    it('treats a queued key as on chain but not as a top-up target', () => {
        const f = computeFrontiers([
            { state: 'in_deposit_queue', balanceEth: 32 },
            { state: 'not_deposited' },
            { state: 'unknown' }
        ], 2048);
        assert.deepEqual(f, { lastDeposited: 0, firstUndeposited: 1, firstBelowCap: -1, maxBalanceEth: 2048, hasActiveKeys: false });
    });

    it('returns -1 everywhere for an empty list', () => {
        assert.deepEqual(computeFrontiers([], 2048), { lastDeposited: -1, firstUndeposited: -1, firstBelowCap: -1, maxBalanceEth: 2048, hasActiveKeys: false });
    });
});

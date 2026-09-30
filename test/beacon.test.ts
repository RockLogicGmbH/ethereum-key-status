import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkFullnodes, estimateQueueWaitSeconds, fetchDepositQueue, fetchValidators, gweiToEth, normalizePubkey } from '../src/beacon.js';
import { beaconHandler, deposit, GWEI, jsonResponse, pubkey, validatorEntry, withFetch } from './fixtures.js';

describe('helpers', () => {
    it('normalises pubkeys and converts gwei', () => {
        assert.equal(normalizePubkey('  ABCdef '), '0xabcdef');
        assert.equal(normalizePubkey('0xABC'), '0xabc');
        assert.equal(gweiToEth('32000000000'), 32);
        // 256 ETH ahead at 256 ETH per epoch = one 384 s epoch.
        assert.equal(estimateQueueWaitSeconds(256 * GWEI, 256), 384);
    });
});

describe('fetchDepositQueue', () => {
    it('aggregates deposits per pubkey with the ETH ahead of the first one', async () => {
        const a = pubkey(1), b = pubkey(2), c = pubkey(3);
        const data = [deposit(a, 32, 10), deposit(b, 1, 11), deposit(a.toUpperCase().replace('0X', ''), 31, 12), deposit(c, 2048, 13), deposit(b, 7, 14)];
        const queue = await withFetch(() => jsonResponse({ data }), async (calls) => {
            const q = await fetchDepositQueue('node:1');
            assert.equal(calls[0].url, 'http://node:1/eth/v1/beacon/states/head/pending_deposits');
            return q;
        });
        assert.ok(queue);
        assert.equal(queue.length, 5);
        assert.equal(queue.totalGwei, (32 + 1 + 31 + 2048 + 7) * GWEI);
        assert.deepEqual(queue.byPubkey.get(a), { position: 0, gweiAhead: 0, amountGwei: 63 * GWEI, deposits: 2, slot: 10 });
        assert.deepEqual(queue.byPubkey.get(b), { position: 1, gweiAhead: 32 * GWEI, amountGwei: 8 * GWEI, deposits: 2, slot: 11 });
        assert.deepEqual(queue.byPubkey.get(c), { position: 3, gweiAhead: 64 * GWEI, amountGwei: 2048 * GWEI, deposits: 1, slot: 13 });
    });

    it('returns null when the node cannot serve the queue', async () => {
        assert.equal(await withFetch(() => jsonResponse({ message: 'nope' }, 404), () => fetchDepositQueue('n')), null);
        assert.equal(await withFetch(() => jsonResponse({ nodata: true }), () => fetchDepositQueue('n')), null);
        assert.equal(await withFetch(() => { throw new TypeError('fetch failed'); }, () => fetchDepositQueue('n')), null);
    });
});

describe('fetchValidators', () => {
    const keys = [pubkey(1), pubkey(2), pubkey(3)];
    const validators = [validatorEntry(keys[0].toUpperCase().replace('0X', '0x'), 1), validatorEntry(keys[2], 3)];

    it('uses a single POST and keys the result by normalised pubkey', async () => {
        const map = await withFetch(beaconHandler(validators, []), async (calls) => {
            const m = await fetchValidators('node:1', keys, 2);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].init?.method, 'POST');
            assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { ids: keys });
            return m;
        });
        assert.deepEqual([...map.keys()], [keys[0], keys[2]]);
        assert.equal(map.get(keys[2])!.index, '3');
    });

    it('falls back to chunked GETs when POST is not supported', async () => {
        const handler = beaconHandler(validators, []);
        const map = await withFetch((url, init) => (init?.method === 'POST' ? jsonResponse({ message: 'no' }, 405) : handler(url, init)), async (calls) => {
            const m = await fetchValidators('node:1', keys, 2);
            assert.equal(calls.length, 3);
            assert.equal(calls[1].url, `http://node:1/eth/v1/beacon/states/head/validators?id=${keys[0]},${keys[1]}`);
            assert.equal(calls[2].url, `http://node:1/eth/v1/beacon/states/head/validators?id=${keys[2]}`);
            return m;
        });
        assert.equal(map.size, 2);
    });

    it('throws when neither form returns data', async () => {
        await withFetch(() => jsonResponse({ code: 500 }), async () => {
            await assert.rejects(fetchValidators('node:1', keys, 500), { message: 'GET validators returned no data array' });
        });
    });
});

describe('checkFullnodes', () => {
    it('keeps synced nodes in order and skips syncing or unreachable ones', async () => {
        const available = await withFetch((url) => {
            if (url.startsWith('http://down')) throw new TypeError('fetch failed');
            return jsonResponse({ data: { is_syncing: url.startsWith('http://syncing'), sync_distance: '0' } });
        }, () => checkFullnodes(['down:1', 'b:2', 'syncing:3', 'a:4']));
        assert.deepEqual(available, ['b:2', 'a:4']);
    });
});

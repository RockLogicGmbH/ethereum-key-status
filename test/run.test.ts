// End-to-end over one run() against a mocked beacon node and webhook: the
// keysets.json and key files are real files in a temp dir.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/run.js';
import { loadRunConfig } from '../src/config.js';
import { buildCards } from '../src/cards.js';
import type { Report, TeamsMessage } from '../src/types.js';
import { beaconHandler, cmv1Batches, cmv2Frontiers, jsonResponse, withFetch, type FetchHandler } from './fixtures.js';

const WEBHOOK = 'https://hooks.example/teams';

describe('run', () => {
    let dir: string;
    const cmv1 = cmv1Batches();
    const cmv2 = cmv2Frontiers();
    const saved = { ...process.env };

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystatus-run-'));
        fs.writeFileSync(path.join(dir, 'v1.json'), JSON.stringify(cmv1.keys));
        fs.writeFileSync(path.join(dir, 'v2.json'), JSON.stringify(cmv2.keys));
        fs.writeFileSync(path.join(dir, 'keysets.json'), JSON.stringify({ keySets: [
            { name: 'Lido CSM v1', type: 'cmv1', keyFile: path.join(dir, 'v1.json') },
            { name: 'Lido CSM v2', type: 'cmv2', keyFile: path.join(dir, 'v2.json'), webhookUrl: WEBHOOK + '/v2' }
        ] }));
        process.env.KEYSETS_PATH = path.join(dir, 'keysets.json');
        process.env.WEBHOOK_URL = WEBHOOK;
    });
    after(() => { process.env = saved; });

    const beacon = beaconHandler([...cmv1.validators, ...cmv2.validators], [...(cmv1.pendingDeposits ?? []), ...(cmv2.pendingDeposits ?? [])]);
    const posts: Array<{ url: string; body: TeamsMessage }> = [];
    const handler: FetchHandler = (url, init) => {
        if (url.startsWith(WEBHOOK)) {
            posts.push({ url, body: JSON.parse(String(init?.body)) as TeamsMessage });
            return new Response(null, { status: 202 });
        }
        return beacon(url, init);
    };

    it('writes a report per set and posts its cards', async () => {
        const config = { ...loadRunConfig(), nodeEndpoints: ['down:1', 'node:2'], resultsDir: path.join(dir, 'results'), webhookDelayMs: 1 };
        const ok = await withFetch((url, init) => {
            if (url.startsWith('http://down:1')) throw new TypeError('fetch failed');
            return handler(url, init);
        }, async (calls) => {
            const result = await run(config);
            // The queue is fetched once per run even with two sets needing it.
            assert.equal(calls.filter(c => c.url.endsWith('/pending_deposits')).length, 1);
            return result;
        });
        assert.equal(ok, true);
        const files = fs.readdirSync(config.resultsDir).sort();
        assert.equal(files.length, 2);
        assert.match(files[0], /^results-lido-csm-v1-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.json$/);
        assert.match(files[1], /^results-lido-csm-v2-/);
        const v2 = JSON.parse(fs.readFileSync(path.join(config.resultsDir, files[1]), 'utf8')) as Report;
        assert.equal(v2.endpoint, 'node:2');
        assert.deepEqual(v2.frontiers, { lastDeposited: 12, firstUndeposited: 13, firstBelowCap: 3, maxBalanceEth: 2048, hasActiveKeys: true });
        assert.deepEqual(posts.map(p => p.url), [WEBHOOK, WEBHOOK + '/v2']);
        assert.deepEqual(posts[1].body, buildCards(v2)[0]);
    });

    it('fails without a synced node, a readable key file or a webhook', async () => {
        const base = { ...loadRunConfig(), resultsDir: path.join(dir, 'results-fail') };
        assert.equal(await withFetch(() => jsonResponse({ data: { is_syncing: true, sync_distance: '99' } }), () => run(base)), false);

        fs.writeFileSync(path.join(dir, 'keysets-bad.json'), JSON.stringify([{ keyFile: path.join(dir, 'missing.json') }]));
        process.env.KEYSETS_PATH = path.join(dir, 'keysets-bad.json');
        assert.equal(await withFetch(handler, () => run(base)), false);

        fs.writeFileSync(path.join(dir, 'keysets-nohook.json'), JSON.stringify([{ keyFile: path.join(dir, 'v2.json'), type: 'cmv2' }]));
        process.env.KEYSETS_PATH = path.join(dir, 'keysets-nohook.json');
        delete process.env.WEBHOOK_URL;
        assert.equal(await withFetch(handler, () => run(base)), false);
        // The report is still written when only the post fails.
        assert.equal(fs.readdirSync(base.resultsDir).length, 1);

        process.env.KEYSETS_PATH = path.join(dir, 'nope', 'keysets.json');
        process.env.KEY_JSON_PATH = path.join(dir, 'v1.json');
        process.env.WEBHOOK_URL = WEBHOOK;
        assert.equal(await withFetch(handler, () => run(base)), true, 'legacy single-set fallback');
    });
});

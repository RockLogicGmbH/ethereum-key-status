import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKeySets, normalizeSet, slugify, TYPE_DEFAULTS } from '../src/keysets.js';

function tmpFile(name: string, content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystatus-keysets-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    return file;
}

describe('slugify', () => {
    it('lowercases and dashes, with a fallback', () => {
        assert.equal(slugify('Lido CSM v2 (Obol DVT)'), 'lido-csm-v2-obol-dvt');
        assert.equal(slugify('--A__b--'), 'a-b');
        assert.equal(slugify('!!!'), 'keyset');
    });
});

describe('normalizeSet', () => {
    afterEach(() => { delete process.env.WEBHOOK_URL; });

    it('applies the type defaults', () => {
        assert.deepEqual(normalizeSet({ keyFile: './keys-cmv1.json' }, 0), {
            name: 'keys-cmv1', slug: 'keys-cmv1', type: 'cmv1', keyFile: './keys-cmv1.json',
            chunkSize: 500, reportBatches: true, perKeyCard: false, webhookUrl: ''
        });
        const cmv2 = normalizeSet({ type: 'cmv2', keyFile: 'a.json' }, 0);
        assert.equal(cmv2.reportBatches, TYPE_DEFAULTS.cmv2.reportBatches);
        assert.equal(cmv2.reportBatches, false);
    });

    it('accepts the keyJsonPath alias, string chunk sizes and truthy flags', () => {
        const set = normalizeSet({ name: 'X', keyJsonPath: 'legacy.json', chunkSize: '250', perKeyCard: 1, reportBatches: 0, slug: 'custom' }, 3);
        assert.equal(set.keyFile, 'legacy.json');
        assert.equal(set.chunkSize, 250);
        assert.equal(set.perKeyCard, true);
        assert.equal(set.reportBatches, false);
        assert.equal(set.slug, 'custom');
        // Unparseable or zero chunk size falls back to the default.
        assert.equal(normalizeSet({ keyFile: 'a.json', chunkSize: 'lots' }, 0).chunkSize, 500);
        assert.equal(normalizeSet({ keyFile: 'a.json', chunkSize: 0 }, 0).chunkSize, 500);
    });

    it('takes the webhook from the set, else from WEBHOOK_URL', () => {
        process.env.WEBHOOK_URL = 'https://env.example/hook';
        assert.equal(normalizeSet({ keyFile: 'a.json' }, 0).webhookUrl, 'https://env.example/hook');
        assert.equal(normalizeSet({ keyFile: 'a.json', webhookUrl: 'https://set.example' }, 0).webhookUrl, 'https://set.example');
    });

    it('rejects unknown types and missing key files', () => {
        assert.throws(() => normalizeSet({ type: 'cmv3', keyFile: 'a.json' }, 1), { message: 'Key set #2: unknown type "cmv3" (expected one of cmv1, cmv2)' });
        assert.throws(() => normalizeSet({ name: 'x' }, 0), { message: 'Key set #1: "keyFile" is required' });
    });
});

describe('loadKeySets', () => {
    it('falls back to the single-set environment variables when the file is missing', () => {
        const sets = loadKeySets({ KEYSETS_PATH: path.join(os.tmpdir(), 'does-not-exist-keysets.json'), KEY_JSON_PATH: './mykeys.json', CHUNK_SIZE: '100' });
        assert.deepEqual(sets, [{
            name: 'Lido Key Status', slug: 'lido-key-status', type: 'cmv1', keyFile: './mykeys.json',
            chunkSize: 100, reportBatches: true, perKeyCard: false, webhookUrl: ''
        }]);
        const typed = loadKeySets({ KEYSETS_PATH: '/nonexistent/k.json', KEYSET_NAME: 'Mine', KEYSET_TYPE: 'cmv2' });
        assert.equal(typed[0].keyFile, 'keys.json');
        assert.equal(typed[0].type, 'cmv2');
        assert.equal(typed[0].name, 'Mine');
    });

    it('reads a bare array and a { keySets } wrapper', () => {
        const list = [{ name: 'A', keyFile: 'a.json' }, { type: 'cmv2', keyFile: 'dir/b.json' }];
        const fromArray = loadKeySets({ KEYSETS_PATH: tmpFile('keysets.json', JSON.stringify(list)) });
        const fromWrapper = loadKeySets({ KEYSETS_PATH: tmpFile('keysets.json', JSON.stringify({ keySets: list })) });
        assert.deepEqual(fromArray, fromWrapper);
        assert.deepEqual(fromArray.map(s => [s.name, s.type]), [['A', 'cmv1'], ['b', 'cmv2']]);
    });

    it('reports unreadable and empty configs', () => {
        const bad = tmpFile('keysets.json', '{ not json');
        assert.throws(() => loadKeySets({ KEYSETS_PATH: bad }), /^Error: Could not read key set config .*keysets\.json: /);
        const empty = tmpFile('keysets.json', '[]');
        assert.throws(() => loadKeySets({ KEYSETS_PATH: empty }), { message: `Key set config ${empty} must contain a non-empty array of key sets` });
        const wrong = tmpFile('keysets.json', '{"sets": []}');
        assert.throws(() => loadKeySets({ KEYSETS_PATH: wrong }), /must contain a non-empty array/);
    });
});

// fixtures.ts - deterministic beacon data and a fetch mock for the tests.
//
// Scenarios are expressed as raw beacon API payloads (validator entries and
// pending deposits), so the same fixture can be pushed through the real
// fetch/parse code rather than hand-building the maps it produces.
import type { KeyEntry, KeySet, PendingDeposit, RawKeySet, ValidatorEntry } from '../src/types.js';
import { normalizeSet } from '../src/keysets.js';

export const GWEI = 1_000_000_000;

// A valid-looking 48-byte pubkey that is unique per (seed, i).
export function pubkey(i: number, seed = 'a'): string {
    const head = seed.charCodeAt(0).toString(16).padStart(2, '0') + i.toString(16).padStart(8, '0');
    return '0x' + head + 'cd'.repeat((96 - head.length) / 2);
}

export interface ValidatorSpec {
    status?: string;
    balanceEth?: number;
    effectiveEth?: number;
    creds?: '0x00' | '0x01' | '0x02';
}

export function validatorEntry(pk: string, index: number, spec: ValidatorSpec = {}): ValidatorEntry {
    const balanceEth = spec.balanceEth ?? 32;
    const creds = spec.creds ?? '0x01';
    return {
        index: String(index),
        balance: String(Math.round(balanceEth * GWEI)),
        status: spec.status ?? 'active_ongoing',
        validator: {
            pubkey: pk,
            withdrawal_credentials: creds + '0000000000000000000000' + 'ef'.repeat(20),
            effective_balance: String(Math.round((spec.effectiveEth ?? Math.min(balanceEth, creds === '0x02' ? 2048 : 32)) * GWEI)),
            slashed: false
        }
    };
}

export function deposit(pk: string, amountEth: number, slot = 1000): PendingDeposit {
    return {
        pubkey: pk,
        withdrawal_credentials: '0x02' + '00'.repeat(31),
        amount: String(Math.round(amountEth * GWEI)),
        signature: '0x' + '00'.repeat(96),
        slot: String(slot)
    };
}

export interface Scenario {
    name: string;
    rawKeySet: RawKeySet;
    keySet: KeySet;
    keys: KeyEntry[];
    validators: ValidatorEntry[];
    // null = the node does not serve the deposit queue.
    pendingDeposits: PendingDeposit[] | null;
}

function scenario(name: string, rawKeySet: RawKeySet, keys: KeyEntry[], validators: ValidatorEntry[], pendingDeposits: PendingDeposit[] | null): Scenario {
    return { name, rawKeySet, keySet: normalizeSet(rawKeySet, 0), keys, validators, pendingDeposits };
}

function keyList(n: number, seed: string, withGenIndex = true): KeyEntry[] {
    return Array.from({ length: n }, (_, i) => (withGenIndex ? { pubkey: pubkey(i, seed), genIndex: i } : { pubkey: pubkey(i, seed) }));
}

// Unrelated deposits ahead in the queue, so positions and ETH-ahead are
// non-trivial.
function queueNoise(n: number): PendingDeposit[] {
    return Array.from({ length: n }, (_, i) => deposit(pubkey(i, 'z'), i % 3 === 0 ? 1 : 32, 900 + i));
}

// cmv1: 1200 keys over three 500-key batches. Mostly active, a few exited,
// some pending, a handful in the queue and a few never deposited.
export function cmv1Batches(): Scenario {
    const keys = keyList(1200, 'a');
    const validators: ValidatorEntry[] = [];
    const deposits = queueNoise(40);
    keys.forEach((key, i) => {
        if (i >= 1190) return; // not deposited
        if (i >= 1180) {
            deposits.push(deposit(key.pubkey, 32, 2000 + i));
            return;
        }
        let status = 'active_ongoing';
        if (i % 97 === 5) status = 'withdrawal_done';
        else if (i % 101 === 7) status = 'active_exiting';
        else if (i >= 1170) status = 'pending_queued';
        validators.push(validatorEntry(key.pubkey, 100000 + i, { status, balanceEth: status === 'withdrawal_done' ? 0 : 32.0123 + (i % 7) / 1000 }));
    });
    return scenario('cmv1 with batches', { name: 'Lido CSM v1', type: 'cmv1', keyFile: './keys-cmv1.json', chunkSize: 500 }, keys, validators, deposits);
}

// cmv2 with both frontiers mid-list: 0-2 at the 2048 cap, 3 below it with a
// top-up queued, 4 a non-0x02 key, 5-9 active at 32, 10-12 still queued,
// 13-19 not deposited.
export function cmv2Frontiers(): Scenario {
    const keys = keyList(20, 'b');
    const validators: ValidatorEntry[] = [];
    const deposits = queueNoise(25);
    keys.forEach((key, i) => {
        if (i <= 2) validators.push(validatorEntry(key.pubkey, 500000 + i, { balanceEth: 2048.004, creds: '0x02' }));
        else if (i === 3) {
            validators.push(validatorEntry(key.pubkey, 500003, { balanceEth: 1056.42, creds: '0x02' }));
            deposits.push(deposit(key.pubkey, 256, 3000));
            deposits.push(deposit(key.pubkey, 64, 3001));
        } else if (i === 4) validators.push(validatorEntry(key.pubkey, 500004, { balanceEth: 32.001, creds: '0x01' }));
        else if (i <= 9) validators.push(validatorEntry(key.pubkey, 500000 + i, { balanceEth: 32 + i / 100, creds: '0x02', status: i === 9 ? 'pending_initialized' : 'active_ongoing' }));
        else if (i <= 12) deposits.push(deposit(key.pubkey, 32, 3100 + i));
    });
    return scenario('cmv2 with frontiers', { name: 'Lido CSM v2 (Obol DVT)', type: 'cmv2', keyFile: './keys-cmv2.json' }, keys, validators, deposits);
}

// cmv2 where every key is on chain and at the cap: "All keys deposited" and
// "every active key is at the cap".
export function cmv2AllAtCap(): Scenario {
    const keys = keyList(6, 'c');
    const validators = keys.map((key, i) => validatorEntry(key.pubkey, 600000 + i, { balanceEth: 2048.5, creds: '0x02' }));
    return scenario('cmv2 all at cap', { name: 'CMv2 full', type: 'cmv2', keyFile: 'full.json' }, keys, validators, []);
}

// cmv2 with nothing deposited yet: "No key deposited yet" and "no key is
// active yet". Keys without genIndex, so labels fall back to position.
export function cmv2NoneDeposited(): Scenario {
    const keys = keyList(4, 'd', false);
    return scenario('cmv2 none deposited', { name: 'CMv2 empty', type: 'cmv2', keyJsonPath: '/data/empty.json' }, keys, [], []);
}

// Node without the pending_deposits endpoint: missing keys are "unknown".
export function unknownQueue(): Scenario {
    const keys = keyList(8, 'e');
    const validators = keys.slice(0, 5).map((key, i) => validatorEntry(key.pubkey, 700000 + i));
    return scenario('unknown when queue is null', { name: 'No queue', type: 'cmv2', keyFile: 'noqueue.json' }, keys, validators, null);
}

// Full per-key listing at the 500-key cmv2 cap, which has to be split.
export function perKeyCard500(): Scenario {
    const keys = keyList(500, 'f');
    const validators: ValidatorEntry[] = [];
    const deposits = queueNoise(10);
    keys.forEach((key, i) => {
        if (i < 120) validators.push(validatorEntry(key.pubkey, 800000 + i, { balanceEth: 32 + (i % 13) / 10, creds: i % 50 === 49 ? '0x01' : '0x02' }));
        else if (i < 250) deposits.push(deposit(key.pubkey, 32, 4000 + i));
    });
    return scenario('perKeyCard at 500 keys', { name: 'Lido CSM v2 (full listing)', type: 'cmv2', keyFile: 'keys-500.json', perKeyCard: true }, keys, validators, deposits);
}

// A small cmv1 set with perKeyCard, which fits one card, plus an uppercase
// pubkey without 0x to exercise normalisation.
export function cmv1SmallPerKey(): Scenario {
    const keys = keyList(12, 'g');
    const validators = keys.slice(0, 10).map((key, i) => validatorEntry(key.pubkey, 900000 + i, { status: i === 3 ? 'exited_unslashed' : 'active_ongoing' }));
    keys[0] = { pubkey: keys[0].pubkey.slice(2).toUpperCase(), genIndex: 0, note: 'extra fields are kept' };
    return scenario('cmv1 small perKeyCard', { name: 'Small set', slug: 'small', type: 'cmv1', keyFile: 'small.json', chunkSize: '5', perKeyCard: true, reportBatches: 1 }, keys, validators, queueNoise(3));
}

export function allScenarios(): Scenario[] {
    return [cmv1Batches(), cmv2Frontiers(), cmv2AllAtCap(), cmv2NoneDeposited(), unknownQueue(), perKeyCard500(), cmv1SmallPerKey()];
}

// ---------------------------------------------------------------------------
// fetch mock.
// ---------------------------------------------------------------------------

export type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Replaces globalThis.fetch for the duration of fn, recording every call.
export async function withFetch<T>(handler: FetchHandler, fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, init });
        return handler(url, init);
    }) as typeof fetch;
    try {
        return await fn(calls);
    } finally {
        globalThis.fetch = original;
    }
}

// A beacon node serving the given scenario data.
export function beaconHandler(validators: ValidatorEntry[], pendingDeposits: PendingDeposit[] | null): FetchHandler {
    return (url, init) => {
        if (url.endsWith('/eth/v1/node/syncing')) {
            return jsonResponse({ data: { is_syncing: false, sync_distance: '0', head_slot: '123' } });
        }
        if (url.includes('/eth/v1/beacon/states/head/validators')) {
            const ids = init?.method === 'POST'
                ? (JSON.parse(String(init.body)) as { ids: string[] }).ids
                : new URL(url).searchParams.get('id')!.split(',');
            const wanted = new Set(ids.map(id => id.toLowerCase()));
            return jsonResponse({ data: validators.filter(v => wanted.has(v.validator.pubkey.toLowerCase())) });
        }
        if (url.endsWith('/eth/v1/beacon/states/head/pending_deposits')) {
            return pendingDeposits === null ? jsonResponse({ message: 'Not found' }, 404) : jsonResponse({ data: pendingDeposits });
        }
        return jsonResponse({ message: 'unexpected ' + url }, 500);
    };
}

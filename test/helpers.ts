// helpers.ts - turns a fixture scenario into buildReport() inputs by running
// it through the real beacon parsing code against a mocked fetch.
import { fetchDepositQueue, fetchValidators, normalizePubkey } from '../src/beacon.js';
import { buildReport } from '../src/status.js';
import type { DepositQueue, KeyEntry, Report, ValidatorMap } from '../src/types.js';
import { beaconHandler, withFetch, type Scenario } from './fixtures.js';

export interface Prepared {
    keys: KeyEntry[];
    validators: ValidatorMap;
    queue: DepositQueue | null;
}

export async function prepare(s: Scenario): Promise<Prepared> {
    const keys = s.keys.map(key => ({ ...key, pubkey: normalizePubkey(key.pubkey) }));
    return withFetch(beaconHandler(s.validators, s.pendingDeposits), async () => ({
        keys,
        validators: await fetchValidators('node:5052', keys.map(k => k.pubkey), s.keySet.chunkSize),
        queue: await fetchDepositQueue('node:5052')
    }));
}

export const REPORT_OPTIONS = { endpoint: 'node:5052', churnEthPerEpoch: 256, maxBalanceEth: 2048 };

export async function reportFor(s: Scenario): Promise<Report> {
    const p = await prepare(s);
    return buildReport(s.keySet, p.keys, p.validators, p.queue, REPORT_OPTIONS);
}

// Every string anywhere in a JSON-able value.
export function allStrings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(v => allStrings(v, out));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { out.push(k); allStrings(v, out); });
    return out;
}

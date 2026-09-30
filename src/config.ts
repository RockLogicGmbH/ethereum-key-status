// config.ts - reads the environment into a typed config.
//
// Every numeric setting uses `parse(...) || default`, so an empty, invalid or
// zero value falls back to the default - the behaviour the plain-JS version
// always had. Keep it that way: existing .env files rely on it.
import path from 'node:path';
import { heartbeatFile } from './heartbeat.js';
import { DEFAULT_MAX_CARD_BYTES, DEFAULT_MAX_FACTS_PER_CARD, DEFAULT_FRONTIER_WINDOW } from './cards.js';

export const DEFAULT_NODE_ENDPOINT = '127.0.0.1:5052,127.0.0.1:3500,127.0.0.1:5051';
// 00:00 on the first day of every quarter (1 Jan, 1 Apr, 1 Jul, 1 Oct) -
// the same expression the host crontab used.
export const DEFAULT_SCHEDULE = '0 0 1 */3 *';

export interface RunConfig {
    nodeEndpoints: string[];
    webhookUrl: string;
    churnEthPerEpoch: number;
    maxCardBytes: number;
    maxFactsPerCard: number;
    frontierWindow: number;
    maxBalanceEth: number;
    webhookDelayMs: number;
    resultsDir: string;
}

export interface SchedulerConfig {
    schedule: string;
    // undefined = the process's local time zone (TZ in the container).
    timezone: string | undefined;
    runOnStart: boolean;
    heartbeatFile: string | undefined;
}

function isTruthy(value: string | undefined): boolean {
    return /^(1|true|yes|on)$/i.test((value || '').trim());
}

export function loadRunConfig(env: NodeJS.ProcessEnv = process.env): RunConfig {
    return {
        nodeEndpoints: (env.NODE_ENDPOINT || DEFAULT_NODE_ENDPOINT).split(','),
        webhookUrl: env.WEBHOOK_URL || '',
        // Mainnet caps the per-epoch deposit churn at 256 ETH, which is what
        // the queue wait estimate is based on.
        churnEthPerEpoch: parseFloat(env.DEPOSIT_CHURN_ETH_PER_EPOCH ?? '') || 256,
        maxCardBytes: parseInt(env.MAX_CARD_BYTES ?? '', 10) || DEFAULT_MAX_CARD_BYTES,
        maxFactsPerCard: parseInt(env.MAX_FACTS_PER_CARD ?? '', 10) || DEFAULT_MAX_FACTS_PER_CARD,
        frontierWindow: parseInt(env.FRONTIER_WINDOW ?? '', 10) || DEFAULT_FRONTIER_WINDOW,
        // EIP-7251 compounding cap: the balance a 0x02 key fills up to.
        maxBalanceEth: parseFloat(env.CMV2_MAX_BALANCE_ETH ?? '') || 2048,
        webhookDelayMs: parseInt(env.WEBHOOK_DELAY_MS ?? '', 10) || 500,
        // Relative to the working directory, like KEYSETS_PATH and keyFile.
        resultsDir: path.resolve(env.RESULTS_DIR || 'results')
    };
}

export function loadSchedulerConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
    return {
        schedule: (env.SCHEDULE || DEFAULT_SCHEDULE).trim(),
        timezone: env.SCHEDULE_TIMEZONE?.trim() || undefined,
        runOnStart: isTruthy(env.RUN_ON_START),
        heartbeatFile: heartbeatFile(env)
    };
}

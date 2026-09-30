// healthcheck.ts - Docker HEALTHCHECK probe for the scheduler.
//
// The scheduler rewrites its heartbeat file every 30 s from a timer on the
// event loop, so a stale file means the process is wedged (or was started in
// --once mode, where there is nothing to check). Kept free of the logger and
// dotenv so a probe every 30 s adds nothing to combined.log.
import fs from 'node:fs';
import { heartbeatFile } from './heartbeat.js';

const MAX_AGE_MS = 120_000;

const file = heartbeatFile();
if (!file) {
    // Heartbeat disabled: nothing to judge by, so report healthy.
    process.exit(0);
}
try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age > MAX_AGE_MS) {
        console.error(`Heartbeat ${file} is ${Math.round(age / 1000)}s old`);
        process.exit(1);
    }
    process.exit(0);
} catch {
    console.error(`No heartbeat file at ${file}`);
    process.exit(1);
}

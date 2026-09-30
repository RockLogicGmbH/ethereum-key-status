#!/usr/bin/env node
// index.ts - command-line entry point.
//
//   node dist/index.js              run as a scheduler (default; the container CMD)
//   node dist/index.js --schedule   same, spelled out
//   node dist/index.js --once       one check, then exit 0 (ok) or 1 (failed)
//
// env.js must stay the first import: it loads .env before logger.js reads
// LOG_DIR.
import './env.js';
import logger from './logger.js';
import { run } from './run.js';
import { startScheduler, type SchedulerHandle } from './scheduler.js';
import { loadSchedulerConfig } from './config.js';

const USAGE = `Usage: node dist/index.js [--once | --schedule]

  --once       Run a single check and exit (0 = success, 1 = failure).
  --schedule   Run checks on the SCHEDULE cron expression until stopped
               (the default when no option is given).
  --help       Show this help.`;

type Mode = 'once' | 'schedule' | 'help';

function parseArgs(argv: string[]): Mode {
    let mode: Mode = 'schedule';
    for (const arg of argv) {
        if (arg === '--once') mode = 'once';
        else if (arg === '--schedule') mode = 'schedule';
        else if (arg === '--help' || arg === '-h') return 'help';
        else throw new Error(`Unknown argument "${arg}"`);
    }
    return mode;
}

// Let the event loop drain rather than calling process.exit() straight away,
// so the log files receive their last lines. The unref'd timer only fires if
// something unexpected keeps the process alive.
function exitWith(code: number): void {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 5000).unref();
}

async function runOnce(): Promise<void> {
    const ok = await run();
    exitWith(ok ? 0 : 1);
}

function runScheduled(): void {
    let handle: SchedulerHandle;
    try {
        handle = startScheduler(loadSchedulerConfig(), () => run());
    } catch (error) {
        logger.error(error instanceof Error ? error.message : String(error));
        exitWith(1);
        return;
    }

    // `docker stop` sends SIGTERM (via tini), Ctrl+C sends SIGINT. Finish the
    // run in progress - a half-posted set of cards is worse than a few more
    // seconds - then exit cleanly. A second signal skips the wait.
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
        if (shuttingDown) {
            logger.warn(`Received ${signal} again - exiting without waiting for the running check`);
            process.exit(1);
        }
        shuttingDown = true;
        logger.info(`Received ${signal} - stopping the scheduler`);
        handle.stop().then(() => {
            logger.info('Scheduler stopped');
            exitWith(0);
        }, (error: unknown) => {
            logger.error('Error while stopping the scheduler: ' + String(error));
            exitWith(1);
        });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

let mode: Mode;
try {
    mode = parseArgs(process.argv.slice(2));
} catch (error) {
    console.error((error instanceof Error ? error.message : String(error)) + '\n\n' + USAGE);
    process.exit(1);
}

if (mode === 'help') {
    console.log(USAGE);
} else if (mode === 'once') {
    void runOnce();
} else {
    runScheduled();
}

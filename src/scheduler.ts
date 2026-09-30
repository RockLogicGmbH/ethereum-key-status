// scheduler.ts - keeps the process alive and runs the check on a cron
// schedule, replacing the host crontab entry the tool used to be run from.
//
// croner is used for standard cron syntax plus a few extensions (optional
// seconds field, `L` for the last day of the month), time zones and overlap
// protection.
import fs from 'node:fs';
import { Cron } from 'croner';
import logger from './logger.js';
import type { SchedulerConfig } from './config.js';

export type RunFn = () => Promise<boolean>;

export interface SchedulerHandle {
    job: Cron;
    // Stops triggering new runs and resolves once an in-flight run is done.
    stop(): Promise<void>;
    // The run currently in progress, if any.
    current(): Promise<boolean> | null;
}

// Builds a paused job purely to validate the pattern and time zone and to
// compute run times. Throws with a readable message when either is invalid,
// or when the pattern can never fire (e.g. "0 0 30 2 *").
export function parseSchedule(pattern: string, timezone?: string): Cron {
    let job: Cron;
    try {
        job = new Cron(pattern, { timezone, paused: true });
        // An invalid time zone only surfaces once a date is converted.
        const next = job.nextRun();
        if (next === null) {
            throw new Error('the pattern never matches a future date');
        }
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid SCHEDULE "${pattern}"${timezone ? ` (timezone ${timezone})` : ''}: ${reason}`);
    }
    // Left paused rather than stopped: a stopped job no longer computes run
    // times, and a paused one holds no timer.
    return job;
}

export function nextRunAfter(pattern: string, timezone: string | undefined, from: Date): Date | null {
    const job = parseSchedule(pattern, timezone);
    return job.nextRun(from);
}

// "2027-01-01 00:00:00 Europe/Vienna" - the schedule's own wall-clock time,
// which is what a cron expression is written in, plus UTC for the log reader
// in another zone.
export function describeRunTime(date: Date | null, timezone?: string): string {
    if (!date) return 'none (the schedule has no future run)';
    const zone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    // sv-SE formats as ISO-like "YYYY-MM-DD HH:mm:ss".
    const local = new Intl.DateTimeFormat('sv-SE', {
        timeZone: zone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).format(date);
    return `${local} ${zone} (${date.toISOString()})`;
}

function capitalize(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function touch(file: string): void {
    try {
        fs.writeFileSync(file, String(Date.now()));
    } catch (error) {
        logger.warn(`Could not write heartbeat file ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function startScheduler(config: SchedulerConfig, runFn: RunFn): SchedulerHandle {
    // Validate before anything is scheduled; the caller turns a throw into
    // exit code 1.
    parseSchedule(config.schedule, config.timezone);

    let inFlight: Promise<boolean> | null = null;
    let stopped = false;

    const logNext = (): void => {
        if (stopped) return;
        logger.info('Next scheduled run: ' + describeRunTime(job.nextRun(), config.timezone));
    };

    const trigger = async (reason: string): Promise<void> => {
        // croner's `protect` already blocks overlapping cron triggers; this
        // also covers RUN_ON_START racing the first cron tick.
        if (inFlight) {
            logger.warn(`Skipping ${reason} run - the previous run is still in progress`);
            return;
        }
        logger.info(`Starting ${reason} run`);
        const started = Date.now();
        inFlight = runFn().catch((error: unknown) => {
            // run() never rejects, but a custom runFn might.
            logger.error('Run failed: ' + (error instanceof Error ? error.message : String(error)));
            return false;
        });
        try {
            const ok = await inFlight;
            const seconds = ((Date.now() - started) / 1000).toFixed(1);
            // A failed run is logged, never fatal: the next one may succeed.
            if (ok) {
                logger.info(`${capitalize(reason)} run finished successfully in ${seconds}s`);
            } else {
                logger.error(`${capitalize(reason)} run finished with errors in ${seconds}s - see above${stopped ? '' : '; the scheduler keeps running'}`);
            }
        } finally {
            inFlight = null;
            logNext();
        }
    };

    const job = new Cron(config.schedule, {
        name: 'keystatus',
        timezone: config.timezone,
        protect: (blocked) => {
            logger.warn(`Skipping run scheduled for ${blocked.currentRun()?.toISOString() ?? 'now'} - the previous run is still in progress`);
        },
        catch: (error) => {
            logger.error('Scheduler error: ' + (error instanceof Error ? error.message : String(error)));
        }
    }, () => trigger('scheduled'));

    logger.info(`Scheduler started with SCHEDULE="${config.schedule}" in ${config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}`);

    let heartbeat: NodeJS.Timeout | undefined;
    if (config.heartbeatFile) {
        const file = config.heartbeatFile;
        touch(file);
        heartbeat = setInterval(() => touch(file), 30_000);
        heartbeat.unref();
    }

    if (config.runOnStart) {
        void trigger('start-up');
    } else {
        logNext();
    }

    return {
        job,
        current: () => inFlight,
        async stop() {
            stopped = true;
            job.stop();
            if (heartbeat) clearInterval(heartbeat);
            if (inFlight) {
                logger.info('Waiting for the running check to finish before exiting');
                await inFlight;
            }
            if (config.heartbeatFile) {
                fs.rmSync(config.heartbeatFile, { force: true });
            }
        }
    };
}

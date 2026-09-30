import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeRunTime, nextRunAfter, parseSchedule, startScheduler } from '../src/scheduler.js';
import { DEFAULT_SCHEDULE, type SchedulerConfig } from '../src/config.js';

const VIENNA = 'Europe/Vienna';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

function config(overrides: Partial<SchedulerConfig> = {}): SchedulerConfig {
    return { schedule: DEFAULT_SCHEDULE, timezone: VIENNA, runOnStart: false, heartbeatFile: undefined, ...overrides };
}

describe('default schedule', () => {
    it('fires at 00:00 on the first day of every quarter', () => {
        const job = parseSchedule(DEFAULT_SCHEDULE, VIENNA);
        const runs = job.nextRuns(5, new Date('2026-01-01T00:00:00+01:00')).map(d => d.toISOString());
        assert.deepEqual(runs, [
            '2026-03-31T22:00:00.000Z', // 1 Apr 00:00 CEST (+02:00)
            '2026-06-30T22:00:00.000Z',
            '2026-09-30T22:00:00.000Z',
            '2026-12-31T23:00:00.000Z', // 1 Jan 00:00 CET (+01:00)
            '2027-03-31T22:00:00.000Z'
        ]);
    });

    it('matches the old host crontab: next run after 30 September is 1 October', () => {
        assert.equal(nextRunAfter(DEFAULT_SCHEDULE, VIENNA, new Date('2026-09-30T10:00:00+02:00'))?.toISOString(), '2026-09-30T22:00:00.000Z');
        assert.equal(nextRunAfter(DEFAULT_SCHEDULE, VIENNA, new Date('2026-10-01T00:00:01+02:00'))?.toISOString(), '2026-12-31T23:00:00.000Z');
    });

    it('describes run times in the schedule time zone', () => {
        assert.equal(describeRunTime(new Date('2026-12-31T23:00:00Z'), VIENNA), '2027-01-01 00:00:00 Europe/Vienna (2026-12-31T23:00:00.000Z)');
        assert.equal(describeRunTime(null, VIENNA), 'none (the schedule has no future run)');
    });
});

describe('parseSchedule', () => {
    it('rejects malformed patterns, unknown zones and patterns that never fire', () => {
        assert.throws(() => parseSchedule('every quarter'), /^Error: Invalid SCHEDULE "every quarter": /);
        assert.throws(() => parseSchedule('61 * * * *'), /Invalid SCHEDULE "61 \* \* \* \*": .*minute/);
        assert.throws(() => parseSchedule(DEFAULT_SCHEDULE, 'Mars/Base'), /\(timezone Mars\/Base\)/);
        assert.throws(() => parseSchedule('0 0 30 2 *'), /never matches a future date/);
    });

    it('accepts the documented examples', () => {
        for (const p of ['0 0 1 */3 *', '0 9 L 3,6,9,12 *', '0 9 1 1,4,7,10 *', '30 23 L * *', '0 8 * * MON', '*/15 * * * *']) {
            assert.doesNotThrow(() => parseSchedule(p, VIENNA), p);
        }
    });
});

describe('startScheduler', () => {
    it('throws on an invalid schedule before scheduling anything', () => {
        assert.throws(() => startScheduler(config({ schedule: 'nope' }), async () => true), /Invalid SCHEDULE/);
    });

    it('runs on start, survives a failed run and waits for it on stop', async () => {
        const heartbeat = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keystatus-hb-')), 'hb');
        const gate = deferred<boolean>();
        let calls = 0;
        const handle = startScheduler(config({ runOnStart: true, heartbeatFile: heartbeat }), () => { calls += 1; return gate.promise; });
        assert.equal(calls, 1);
        assert.ok(fs.existsSync(heartbeat));
        assert.ok(handle.current());

        let stopped = false;
        const stopping = handle.stop().then(() => { stopped = true; });
        await new Promise(r => setTimeout(r, 50));
        assert.equal(stopped, false, 'stop() must wait for the in-flight run');
        gate.resolve(false); // a failed run: logged, not thrown
        await stopping;
        assert.equal(stopped, true);
        assert.equal(handle.current(), null);
        assert.equal(handle.job.isStopped(), true);
        assert.equal(fs.existsSync(heartbeat), false);
    });

    it('never overlaps runs', async () => {
        let calls = 0;
        let running = 0;
        let maxRunning = 0;
        const handle = startScheduler(config({ schedule: '* * * * * *', runOnStart: true }), async () => {
            calls += 1;
            running += 1;
            maxRunning = Math.max(maxRunning, running);
            await new Promise(r => setTimeout(r, 2200));
            running -= 1;
            return true;
        });
        await new Promise(r => setTimeout(r, 2000));
        assert.equal(calls, 1, 'second-by-second triggers are skipped while the first run is busy');
        await handle.stop();
        assert.equal(maxRunning, 1);
    });

    it('keeps running when the run function rejects', async () => {
        const handle = startScheduler(config({ runOnStart: true }), async () => { throw new Error('boom'); });
        await new Promise(r => setTimeout(r, 20));
        assert.equal(handle.current(), null);
        assert.equal(handle.job.isStopped(), false);
        await handle.stop();
    });
});

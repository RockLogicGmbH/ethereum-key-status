// heartbeat.ts - where the scheduler's liveness file lives.
//
// A module of its own, free of imports that pull in the logger, so the
// Docker HEALTHCHECK probe (healthcheck.ts) stays tiny and never opens the
// log files.
import os from 'node:os';
import path from 'node:path';

// Touched by the scheduler while it is alive; the Docker HEALTHCHECK reads
// it. HEARTBEAT_FILE= (set but empty) turns it off.
export function heartbeatFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (env.HEARTBEAT_FILE === undefined) return path.join(os.tmpdir(), 'keystatus.heartbeat');
    return env.HEARTBEAT_FILE || undefined;
}

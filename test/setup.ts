// setup.ts - loaded via --import before every test file (see package.json).
//
// Keeps test runs out of the working tree's combined.log / error.log and off
// the console: LOG_DIR has to be set before logger.ts is first imported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'keystatus-test-logs-'));
// No real webhook, ever.
delete process.env.WEBHOOK_URL;

const { default: logger } = await import('../src/logger.js');
logger.silent = !process.env.TEST_LOGS;

// logger.ts
import path from 'node:path';
import winston from 'winston';

const { createLogger, format, transports } = winston;

// combined.log / error.log land in LOG_DIR, which defaults to the working
// directory (where they have always been written). In the container it
// points at a mounted volume. Read when this module is first imported, so
// dotenv has to be loaded before that (see env.ts).
const logDir = process.env.LOG_DIR || '.';

const logger = createLogger({
  level: 'info',
  format: format.combine(
    // Include a timestamp; optionally specify the format you want
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    // Use printf to create a custom log format string
    format.printf(({ level, message, timestamp }) => {
      // Return the exact structure you want
      // Here, timestamp appears first
      return `${String(timestamp)} [${level.toUpperCase()}]: ${String(message)}`;
    })
  ),
  transports: [
    // Write all logs with level `info` and below to `combined.log`
    new transports.File({ filename: path.join(logDir, 'combined.log') }),
    // Write all logs with level `error` and below to `error.log`
    new transports.File({ filename: path.join(logDir, 'error.log'), level: 'error' }),
    new transports.Console()
  ]
});

export default logger;

// logger.js
const { createLogger, format, transports } = require('winston');

const logger = createLogger({
  level: 'info',
  format: format.combine(
    // Include a timestamp; optionally specify the format you want
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    // Use printf to create a custom log format string
    format.printf(({ level, message, timestamp }) => {
      // Return the exact structure you want
      // Here, timestamp appears first
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    // Write all logs with level `info` and below to `combined.log`
    new transports.File({ filename: 'combined.log' }),
    // Write all logs with level `error` and below to `error.log`
    new transports.File({ filename: 'error.log', level: 'error' }),
    new transports.Console()
  ]
});

module.exports = logger;

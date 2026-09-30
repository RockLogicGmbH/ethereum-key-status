// env.ts - loads .env into process.env.
//
// Imported first by every entry point: ES module imports are evaluated in
// order, and logger.ts reads LOG_DIR the moment it is imported, so .env has
// to be applied before anything pulls the logger in. Variables already set
// in the real environment (e.g. by docker compose) win over .env.
import dotenv from 'dotenv';

dotenv.config();

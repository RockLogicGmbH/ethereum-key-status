// keysets.js - resolves which sets of keys a run should check.
//
// A run checks one or more key sets and posts one Teams card per set. Sets
// are declared in a JSON config file (KEYSETS_PATH); when that file is
// absent the legacy single-set environment variables are used instead, so
// an existing .env keeps working unchanged.
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const TYPES = ['cmv1', 'cmv2'];

// cmv2 keys live on a single Obol DVT cluster and are capped at 500, so the
// whole set goes out in one request; chunking only ever applies to the GET
// fallback. cmv1 keeps the per-batch breakdown it has always reported.
//
// Neither type lists every key by default - at 500 keys that is unreadable
// and does not fit a Teams card. Set "perKeyCard": true on a set to get the
// full listing anyway.
const TYPE_DEFAULTS = {
    cmv1: { chunkSize: 500, reportBatches: true, perKeyCard: false },
    cmv2: { chunkSize: 500, reportBatches: false, perKeyCard: false }
};

function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'keyset';
}

function normalizeSet(raw, index) {
    const type = raw.type || 'cmv1';
    if (!TYPES.includes(type)) {
        throw new Error(`Key set #${index + 1}: unknown type "${type}" (expected one of ${TYPES.join(', ')})`);
    }
    const keyFile = raw.keyFile || raw.keyJsonPath;
    if (!keyFile) {
        throw new Error(`Key set #${index + 1}: "keyFile" is required`);
    }
    const defaults = TYPE_DEFAULTS[type];
    const name = raw.name || path.basename(keyFile, '.json');
    return {
        name,
        slug: raw.slug || slugify(name),
        type,
        keyFile,
        chunkSize: parseInt(raw.chunkSize, 10) || defaults.chunkSize,
        reportBatches: raw.reportBatches !== undefined ? !!raw.reportBatches : defaults.reportBatches,
        perKeyCard: raw.perKeyCard !== undefined ? !!raw.perKeyCard : defaults.perKeyCard,
        webhookUrl: raw.webhookUrl || process.env.WEBHOOK_URL || ''
    };
}

function loadKeySets(env = process.env) {
    const configPath = env.KEYSETS_PATH || './keysets.json';
    const resolved = path.resolve(configPath);

    if (!fs.existsSync(resolved)) {
        // Legacy single-set mode.
        logger.info(`No key set config at ${configPath} - using the single key file from the environment`);
        return [normalizeSet({
            name: env.KEYSET_NAME || 'Lido Key Status',
            type: env.KEYSET_TYPE || 'cmv1',
            keyFile: env.KEY_JSON_PATH || 'keys.json',
            chunkSize: env.CHUNK_SIZE
        }, 0)];
    }

    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (error) {
        throw new Error(`Could not read key set config ${configPath}: ${error.message}`);
    }
    const list = Array.isArray(parsed) ? parsed : parsed.keySets;
    if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`Key set config ${configPath} must contain a non-empty array of key sets`);
    }
    const sets = list.map(normalizeSet);
    logger.info(`Loaded ${sets.length} key set(s) from ${configPath}: ${sets.map(s => `${s.name} (${s.type})`).join(', ')}`);
    return sets;
}

module.exports = { loadKeySets, slugify, TYPES, TYPE_DEFAULTS };

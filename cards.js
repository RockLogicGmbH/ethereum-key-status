// cards.js — builds the Adaptive Cards posted to Teams.
const { IN_DEPOSIT_QUEUE, NOT_DEPOSITED, UNKNOWN } = require('./status');

// Teams Workflows answers 202 the moment it receives the POST, before it
// tries to render the card, so an oversized payload is accepted and then
// dropped without any error reaching us. The documented ceiling is ~28 KB;
// stay well under it, and cap the row count too — long FactSets fail to
// render before they hit any byte limit.
const DEFAULT_MAX_CARD_BYTES = 16000;
const DEFAULT_MAX_FACTS_PER_CARD = 100;
// Keys shown either side of a frontier.
const DEFAULT_FRONTIER_WINDOW = 2;
const COMPOUNDING_CREDENTIALS = '0x02';

function formatEth(eth) {
    return `${Number(eth).toFixed(2)} ETH`;
}

function shortPubkey(pubkey) {
    return `${pubkey.slice(0, 10)}…${pubkey.slice(-6)}`;
}

function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return 'now';
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h`;
    return `${Math.round(seconds / 86400)} d`;
}

function keyLabel(key, marked) {
    const index = key.genIndex !== undefined ? key.genIndex : key.position;
    return `${marked ? '▸ ' : ''}#${index} ${shortPubkey(key.pubkey)}`;
}

function keyValue(key, type) {
    if (key.state === IN_DEPOSIT_QUEUE) {
        return `${formatEth(key.balanceEth)} · in queue #${key.queue.position} · ~${formatDuration(key.queue.estimatedWaitSeconds)}`;
    }
    if (key.state === NOT_DEPOSITED) return 'not deposited';
    if (key.state === UNKNOWN) return 'no validator record';

    let value = `${formatEth(key.balanceEth)} · ${key.state}`;
    if (key.pendingTopUpEth) {
        value += ` · +${formatEth(key.pendingTopUpEth)} queued`;
    }
    // A cmv2 key that is not 0x02 cannot accumulate past 32 ETH — worth
    // seeing at a glance rather than hunting for in the JSON report.
    if (type === 'cmv2' && key.credentials && key.credentials !== COMPOUNDING_CREDENTIALS) {
        value += ` · ⚠ ${key.credentials}`;
    }
    return value;
}

function keyFact(key, type, marked = false) {
    return { title: keyLabel(key, marked), value: keyValue(key, type) };
}

function summaryFacts(report) {
    const facts = [
        { title: 'Keys', value: String(report.totals.keys) },
        { title: 'Active (incl. queue)', value: String(report.totals.active) }
    ];
    Object.keys(report.stateCounts).sort().forEach((state) => {
        facts.push({ title: state, value: String(report.stateCounts[state]) });
    });
    if (report.type === 'cmv2') {
        facts.push({ title: 'Total balance', value: formatEth(report.totals.balanceTotalEth) });
        facts.push({
            title: 'Avg / min / max',
            value: `${Number(report.totals.balanceAvgEth).toFixed(2)} / ${Number(report.totals.balanceMinEth).toFixed(2)} / ${Number(report.totals.balanceMaxEth).toFixed(2)} ETH`
        });
        if (report.totals.pendingTopUpEth > 0) {
            facts.push({ title: 'Queued top-ups', value: formatEth(report.totals.pendingTopUpEth) });
        }
        const nonCompounding = Object.entries(report.credentials)
            .filter(([type]) => type !== COMPOUNDING_CREDENTIALS)
            .reduce((sum, [, count]) => sum + count, 0);
        if (nonCompounding > 0) {
            facts.push({ title: '⚠ Not 0x02', value: String(nonCompounding) });
        }
    }
    if (report.batches) {
        Object.keys(report.batches).forEach((batch) => {
            facts.push({ title: batch, value: String(report.batches[batch]) });
        });
    }
    return facts;
}

// A handful of keys either side of a boundary, with the boundary key marked.
function windowFacts(report, from, to, marked) {
    const facts = [];
    for (let i = Math.max(0, from); i <= Math.min(report.keys.length - 1, to); i++) {
        facts.push(keyFact(report.keys[i], report.type, i === marked));
    }
    return facts;
}

// The two windows that say where things currently stand: how far down the key
// list deposits have reached, and which key the next top-up fills.
function frontierSections(report, window) {
    const { lastDeposited, firstUndeposited, firstBelowCap, maxBalanceEth, hasActiveKeys } = report.frontiers;
    const sections = [];

    if (lastDeposited >= 0 && firstUndeposited >= 0) {
        sections.push({
            header: 'Deposit frontier — last key on chain → first not deposited',
            facts: windowFacts(report, lastDeposited - window + 1, firstUndeposited + window - 1, lastDeposited)
        });
    } else if (lastDeposited < 0) {
        sections.push({ header: 'Deposit frontier', facts: [{ title: 'No key deposited yet', value: `0 of ${report.totals.keys}` }] });
    } else {
        sections.push({ header: 'Deposit frontier', facts: [{ title: 'All keys deposited', value: `${report.totals.keys} of ${report.totals.keys}` }] });
    }

    if (firstBelowCap >= 0) {
        sections.push({
            header: `Fill frontier — first key below ${maxBalanceEth} ETH`,
            facts: windowFacts(report, firstBelowCap - window + 1, firstBelowCap + window, firstBelowCap)
        });
    } else {
        sections.push({
            header: `Fill frontier — first key below ${maxBalanceEth} ETH`,
            facts: [hasActiveKeys
                ? { title: 'None', value: `every active key is at the ${maxBalanceEth} ETH cap` }
                : { title: 'None', value: 'no key is active yet' }]
        });
    }

    return sections;
}

function makeMessage(title, sections) {
    const body = [{
        type: 'TextBlock',
        text: title,
        wrap: true,
        color: 'Accent',
        isSubtle: false,
        weight: 'Bolder',
        size: 'Large'
    }];
    for (const section of sections) {
        if (!section || !section.facts || section.facts.length === 0) continue;
        if (section.header) {
            body.push({ type: 'TextBlock', text: section.header, wrap: true, weight: 'Bolder', spacing: 'Medium' });
        }
        body.push({ type: 'FactSet', facts: section.facts });
    }
    return {
        type: 'message',
        attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
                type: 'AdaptiveCard',
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                version: '1.5',
                body
            }
        }]
    };
}

// Adaptive Card FactSet requires title/value to be strings; numeric values
// (e.g. validator counts) otherwise fail to render in Teams.
function getAdaptiveCard(data, title = 'Lido Key Status') {
    const facts = Object.entries(data).map(([key, value]) => ({
        title: String(key),
        value: String(value)
    }));
    return makeMessage(title, [{ facts }]);
}

// Largest number of rows that still fits the budget, found by bisection so
// a single oversized row cannot wedge the loop.
function fittingRowCount(title, facts, maxBytes, maxFacts) {
    let low = 1;
    let high = Math.min(facts.length, maxFacts);
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (JSON.stringify(makeMessage(title, [{ facts: facts.slice(0, mid) }])).length <= maxBytes) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low;
}

// Listing every key is unreadable at 500 keys, so a cmv2 set reports the
// summary plus the two frontier windows. The full per-key listing is still
// available by setting "perKeyCard": true on the key set; it is then spread
// evenly over as many cards as the size budget allows, with the summary on a
// card of its own so it cannot be the one that grows large enough to drop.
function buildCards(report, options = {}) {
    const maxBytes = options.maxBytes || DEFAULT_MAX_CARD_BYTES;
    const maxFacts = options.maxFacts || DEFAULT_MAX_FACTS_PER_CARD;
    const window = options.frontierWindow || DEFAULT_FRONTIER_WINDOW;

    const sections = [{ facts: summaryFacts(report) }];
    if (report.type === 'cmv2' && report.frontiers) {
        sections.push(...frontierSections(report, window));
    }

    if (!report.perKeyCard) {
        return [makeMessage(report.name, sections)];
    }

    const facts = report.keys.map(key => keyFact(key, report.type));
    const single = makeMessage(report.name, sections.concat([{ header: 'Per-key balances', facts }]));
    if (facts.length <= maxFacts && JSON.stringify(single).length <= maxBytes) {
        return [single];
    }

    // Measured against a worst-case title so the real titles always fit.
    const probeTitle = `${report.name} — keys (99/99)`;
    const perCard = fittingRowCount(probeTitle, facts, maxBytes, maxFacts);
    const cardCount = Math.ceil(facts.length / perCard);
    const evenRows = Math.ceil(facts.length / cardCount);

    const cards = [makeMessage(report.name, sections)];
    for (let i = 0; i < cardCount; i++) {
        const slice = facts.slice(i * evenRows, (i + 1) * evenRows);
        if (slice.length === 0) break;
        const title = cardCount > 1 ? `${report.name} — keys (${i + 1}/${cardCount})` : `${report.name} — keys`;
        cards.push(makeMessage(title, [{ facts: slice }]));
    }
    return cards;
}

module.exports = {
    buildCards,
    getAdaptiveCard,
    keyFact,
    summaryFacts,
    frontierSections,
    formatEth,
    formatDuration,
    shortPubkey,
    DEFAULT_MAX_CARD_BYTES,
    DEFAULT_MAX_FACTS_PER_CARD,
    DEFAULT_FRONTIER_WINDOW
};

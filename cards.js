// cards.js — builds the Adaptive Cards posted to Teams.
const { IN_DEPOSIT_QUEUE, NOT_DEPOSITED, UNKNOWN } = require('./status');

// Teams rejects payloads over ~28 KB. A cmv2 set lists one row per key and
// can reach 500 keys, so the rows are spread over as many cards as needed.
const DEFAULT_MAX_CARD_BYTES = 25000;
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

function keyFact(key, type) {
    const title = shortPubkey(key.pubkey);
    if (key.state === IN_DEPOSIT_QUEUE) {
        const eta = formatDuration(key.queue.estimatedWaitSeconds);
        return { title, value: `${formatEth(key.balanceEth)} · in queue #${key.queue.position} · ~${eta}` };
    }
    if (key.state === NOT_DEPOSITED) {
        return { title, value: 'not deposited' };
    }
    if (key.state === UNKNOWN) {
        return { title, value: 'no validator record' };
    }
    let value = `${formatEth(key.balanceEth)} · ${key.state}`;
    if (key.pendingTopUpEth) {
        value += ` · +${formatEth(key.pendingTopUpEth)} queued`;
    }
    // A cmv2 key that is not 0x02 cannot accumulate past 32 ETH — worth
    // seeing at a glance rather than hunting for in the JSON report.
    if (type === 'cmv2' && key.credentials && key.credentials !== COMPOUNDING_CREDENTIALS) {
        value += ` · ⚠ ${key.credentials}`;
    }
    return { title, value };
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

function makeMessage(title, facts, keyFacts) {
    const body = [{
        type: 'TextBlock',
        text: title,
        wrap: true,
        color: 'Accent',
        isSubtle: false,
        weight: 'Bolder',
        size: 'Large'
    }];
    if (facts && facts.length) {
        body.push({ type: 'FactSet', facts });
    }
    if (keyFacts && keyFacts.length) {
        if (facts && facts.length) {
            body.push({ type: 'TextBlock', text: 'Per-key balances', wrap: true, weight: 'Bolder', spacing: 'Medium' });
        }
        body.push({ type: 'FactSet', facts: keyFacts });
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
    return makeMessage(title, facts);
}

// Returns the list of Teams messages for one key set: a single card for the
// aggregate view, or a summary card followed by as many per-key cards as the
// size budget requires.
function buildCards(report, maxBytes = DEFAULT_MAX_CARD_BYTES) {
    const summary = summaryFacts(report);
    if (!report.perKeyCard) {
        return [makeMessage(report.name, summary)];
    }

    const facts = report.keys.map(key => keyFact(key, report.type));
    // Measured against a worst-case title so the real titles always fit.
    const probeTitle = `${report.name} (99/99)`;
    const groups = [];
    let current = [];
    let withSummary = true;
    for (const fact of facts) {
        const candidate = current.concat([fact]);
        const size = JSON.stringify(makeMessage(probeTitle, withSummary ? summary : null, candidate)).length;
        if (current.length > 0 && size > maxBytes) {
            groups.push({ facts: current, summary: withSummary });
            withSummary = false;
            current = [fact];
        } else {
            current = candidate;
        }
    }
    groups.push({ facts: current, summary: withSummary });

    return groups.map((group, i) => {
        const title = groups.length > 1 ? `${report.name} (${i + 1}/${groups.length})` : report.name;
        return makeMessage(title, group.summary ? summary : null, group.facts);
    });
}

module.exports = {
    buildCards,
    getAdaptiveCard,
    keyFact,
    summaryFacts,
    formatEth,
    formatDuration,
    shortPubkey,
    DEFAULT_MAX_CARD_BYTES
};

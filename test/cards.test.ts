import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCards,
    formatDuration,
    formatEth,
    frontierSections,
    getAdaptiveCard,
    keyFact,
    keyValue,
    shortPubkey,
    summaryFacts,
    DEFAULT_MAX_CARD_BYTES,
    DEFAULT_MAX_FACTS_PER_CARD
} from '../src/cards.js';
import type { FactSet, KeyReport, TeamsMessage, TextBlock } from '../src/types.js';
import { allScenarios, cmv1Batches, cmv1SmallPerKey, cmv2AllAtCap, cmv2Frontiers, cmv2NoneDeposited, perKeyCard500 } from './fixtures.js';
import { allStrings, reportFor } from './helpers.js';

function body(message: TeamsMessage) {
    return message.attachments[0].content.body;
}
function title(message: TeamsMessage): string {
    return (body(message)[0] as TextBlock).text;
}
function factSets(message: TeamsMessage): FactSet[] {
    return body(message).filter((e): e is FactSet => e.type === 'FactSet');
}
function headers(message: TeamsMessage): string[] {
    return body(message).slice(1).filter((e): e is TextBlock => e.type === 'TextBlock').map(e => e.text);
}

const PK = '0xabcdef0123456789' + '00'.repeat(40);

describe('formatting', () => {
    it('formats ETH, durations and pubkeys', () => {
        assert.equal(formatEth(32), '32.00 ETH');
        assert.equal(formatEth(2048.004), '2048.00 ETH');
        assert.equal(formatEth(undefined), 'NaN ETH');
        assert.equal(shortPubkey(PK), '0xabcdef');
        assert.equal(formatDuration(0), 'now');
        assert.equal(formatDuration(-5), 'now');
        assert.equal(formatDuration(Infinity), 'now');
        assert.equal(formatDuration(59 * 60), '59 min');
        assert.equal(formatDuration(3600), '1 h');
        assert.equal(formatDuration(86399), '24 h');
        assert.equal(formatDuration(3456000), '40 d');
    });

    it('renders every key state', () => {
        const base: KeyReport = { pubkey: PK, genIndex: 7, state: 'active_ongoing', position: 2 };
        assert.equal(keyValue({ ...base, balanceEth: 32.004 }, 'cmv1'), '32.00 ETH | active_ongoing');
        assert.equal(keyValue({ ...base, balanceEth: 1056.42, pendingTopUpEth: 256, credentials: '0x02' }, 'cmv2'), '1056.42 ETH | active_ongoing | +256.00 ETH queued');
        assert.equal(keyValue({ ...base, balanceEth: 32, credentials: '0x01' }, 'cmv2'), '32.00 ETH | active_ongoing | non-compounding 0x01');
        // Non-compounding is only flagged on cmv2 sets.
        assert.equal(keyValue({ ...base, balanceEth: 32, credentials: '0x01' }, 'cmv1'), '32.00 ETH | active_ongoing');
        assert.equal(keyValue({ ...base, state: 'in_deposit_queue', balanceEth: 32, queue: { position: 48213, ethAhead: 1, estimatedWaitSeconds: 3456000 } }, 'cmv2'), '32.00 ETH | in queue #48213 | ~40 d');
        assert.equal(keyValue({ ...base, state: 'not_deposited' }, 'cmv2'), 'not deposited');
        assert.equal(keyValue({ ...base, state: 'unknown' }, 'cmv2'), 'no validator record');
    });

    it('labels keys by genIndex, else by position, with the frontier marker', () => {
        assert.deepEqual(keyFact({ pubkey: PK, genIndex: 7, position: 2, state: 'not_deposited' }, 'cmv2'), { title: '#7 0xabcdef', value: 'not deposited' });
        assert.deepEqual(keyFact({ pubkey: PK, position: 2, state: 'not_deposited' }, 'cmv2', true), { title: '=> #2 0xabcdef', value: 'not deposited' });
    });

    it('stringifies flat status data', () => {
        const card = getAdaptiveCard({ active: 5, name: 'x' });
        assert.equal(title(card), 'Lido Key Status');
        assert.deepEqual(factSets(card)[0].facts, [{ title: 'active', value: '5' }, { title: 'name', value: 'x' }]);
        assert.equal(card.attachments[0].content.version, '1.5');
        assert.equal(card.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    });
});

describe('summaryFacts', () => {
    it('lists totals, sorted states and batches for cmv1', async () => {
        const facts = summaryFacts(await reportFor(cmv1Batches()));
        assert.deepEqual(facts.slice(0, 2).map(f => f.title), ['Keys', 'Active (incl. queue)']);
        const states = facts.slice(2, -3).map(f => f.title);
        assert.deepEqual(states, [...states].sort());
        assert.deepEqual(facts.slice(-3).map(f => f.title), ['0-500', '500-1000', '1000-1500']);
        assert.equal(facts.some(f => f.title === 'Total balance'), false);
    });

    it('adds balances, top-ups and non-compounding count for cmv2', async () => {
        const facts = summaryFacts(await reportFor(cmv2Frontiers()));
        const byTitle = Object.fromEntries(facts.map(f => [f.title, f.value]));
        assert.equal(byTitle['Keys'], '20');
        assert.equal(byTitle['Active (incl. queue)'], '13');
        assert.match(byTitle['Total balance'], /^\d+\.\d\d ETH$/);
        assert.match(byTitle['Avg / min / max'], /^\d+\.\d\d \/ 32\.00 \/ 2048\.00 ETH$/);
        assert.equal(byTitle['Queued top-ups'], '320.00 ETH');
        assert.equal(byTitle['Not 0x02 (non-compounding)'], '1');
    });
});

describe('frontierSections', () => {
    it('windows both frontiers and marks the frontier key', async () => {
        const report = await reportFor(cmv2Frontiers());
        const [deposit, fill] = frontierSections(report, 2);
        assert.equal(deposit.header, 'Deposit frontier - last key on chain -> first not deposited');
        assert.deepEqual(deposit.facts.map(f => f.title.replace(/ 0x.*/, '')), ['#11', '=> #12', '#13', '#14']);
        assert.equal(deposit.facts[3].value, 'not deposited');
        assert.equal(fill.header, 'Fill frontier - first key below 2048 ETH');
        assert.deepEqual(fill.facts.map(f => f.title.replace(/ 0x.*/, '')), ['#2', '=> #3', '#4', '#5']);
        assert.equal(fill.facts[1].value, '1056.42 ETH | active_ongoing | +320.00 ETH queued');
        assert.equal(fill.facts[2].value, '32.00 ETH | active_ongoing | non-compounding 0x01');
    });

    it('widens with the window and clamps at the list edges', async () => {
        const report = await reportFor(cmv2Frontiers());
        const [deposit, fill] = frontierSections(report, 5);
        assert.equal(deposit.facts.length, 10); // 8..17
        assert.equal(fill.facts.length, 9); // clamped 0..8
        assert.equal(fill.facts[0].title.startsWith('#0 '), true);
    });

    it('summarises sets with nothing, or everything, deposited', async () => {
        const none = frontierSections(await reportFor(cmv2NoneDeposited()), 2);
        assert.deepEqual(none, [
            { header: 'Deposit frontier', facts: [{ title: 'No key deposited yet', value: '0 of 4' }] },
            { header: 'Fill frontier - first key below 2048 ETH', facts: [{ title: 'None', value: 'no key is active yet' }] }
        ]);
        const full = frontierSections(await reportFor(cmv2AllAtCap()), 2);
        assert.deepEqual(full, [
            { header: 'Deposit frontier', facts: [{ title: 'All keys deposited', value: '6 of 6' }] },
            { header: 'Fill frontier - first key below 2048 ETH', facts: [{ title: 'None', value: 'every active key is at the 2048 ETH cap' }] }
        ]);
    });
});

describe('buildCards', () => {
    it('posts one summary card for cmv1 and no frontiers', async () => {
        const cards = buildCards(await reportFor(cmv1Batches()));
        assert.equal(cards.length, 1);
        assert.equal(title(cards[0]), 'Lido CSM v1');
        assert.deepEqual(headers(cards[0]), []);
    });

    it('posts one card with summary and both frontiers for cmv2', async () => {
        const cards = buildCards(await reportFor(cmv2Frontiers()));
        assert.equal(cards.length, 1);
        assert.deepEqual(headers(cards[0]), ['Deposit frontier - last key on chain -> first not deposited', 'Fill frontier - first key below 2048 ETH']);
        assert.equal(factSets(cards[0]).length, 3);
    });

    it('keeps a small perKeyCard listing on the one card', async () => {
        const cards = buildCards(await reportFor(cmv1SmallPerKey()));
        assert.equal(cards.length, 1);
        assert.deepEqual(headers(cards[0]), ['Per-key balances']);
        assert.equal(factSets(cards[0])[1].facts.length, 12);
    });

    it('splits 500 perKeyCard rows evenly over cards that fit the budget', async () => {
        const report = await reportFor(perKeyCard500());
        const cards = buildCards(report);
        const rowCards = cards.slice(1);
        assert.ok(rowCards.length >= 5, `expected >= 5 row cards, got ${rowCards.length}`);
        // Summary card first, carrying the frontiers but no rows.
        assert.equal(title(cards[0]), 'Lido CSM v2 (full listing)');
        assert.equal(headers(cards[0]).includes('Per-key balances'), false);
        const rows = rowCards.map(c => factSets(c)[0].facts.length);
        assert.equal(rows.reduce((a, b) => a + b, 0), 500);
        assert.ok(Math.max(...rows) - Math.min(...rows) <= Math.ceil(500 / rowCards.length), 'rows spread evenly');
        rowCards.forEach((card, i) => {
            assert.equal(title(card), `Lido CSM v2 (full listing) - keys (${i + 1}/${rowCards.length})`);
            assert.ok(JSON.stringify(card).length <= DEFAULT_MAX_CARD_BYTES);
            assert.ok(factSets(card)[0].facts.length <= DEFAULT_MAX_FACTS_PER_CARD);
        });
        // Every key appears exactly once, in order.
        const titles = rowCards.flatMap(c => factSets(c)[0].facts.map(f => f.title));
        assert.deepEqual(titles, report.keys.map(k => `#${k.genIndex} ${k.pubkey.slice(0, 8)}`));
    });

    it('respects tighter byte and row budgets', async () => {
        const report = await reportFor(perKeyCard500());
        const cards = buildCards(report, { maxBytes: 4000, maxFacts: 30 });
        for (const card of cards.slice(1)) {
            assert.ok(JSON.stringify(card).length <= 4000);
            assert.ok(factSets(card)[0].facts.length <= 30);
        }
        // 0 means "default", as with the env variables.
        assert.deepEqual(buildCards(report, { maxBytes: 0, maxFacts: 0, frontierWindow: 0 }), buildCards(report));
    });

    it('titles a single overflow card without a counter', async () => {
        const report = { ...(await reportFor(cmv1SmallPerKey())), name: 'X' };
        const cards = buildCards(report, { maxFacts: 11 });
        assert.deepEqual(cards.map(title), ['X', 'X - keys (1/2)', 'X - keys (2/2)']);
        // One row over the byte budget still makes progress.
        const tiny = buildCards(report, { maxBytes: 10 });
        assert.equal(tiny.length, 13);
        assert.equal(title(tiny[1]), 'X - keys (1/12)');
    });

    it('produces ASCII-only cards for every scenario', async () => {
        for (const s of allScenarios()) {
            const cards = buildCards(await reportFor(s));
            for (const text of allStrings(cards)) {
                assert.match(text, /^[\x20-\x7e]*$/, `${s.name}: non-ASCII in ${JSON.stringify(text)}`);
            }
        }
    });
});

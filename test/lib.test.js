import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createEmptyState,
    dateKey,
    normalizeDealerUrl,
    normalizePhone,
    remainingDailyAllowance,
    seedState,
} from '../src/lib.js';

test('normalizes only Mobile.bg dealer subdomains', () => {
    assert.equal(normalizeDealerUrl('https://ATLANTICDRIVE.mobile.bg/contacts'), 'https://atlanticdrive.mobile.bg');
    assert.equal(normalizeDealerUrl('https://www.mobile.bg/dealers'), null);
    assert.equal(normalizeDealerUrl('https://example.com'), null);
});

test('normalizes Bulgarian phone formats', () => {
    assert.equal(normalizePhone('+359 888 003 994'), '0888003994');
    assert.equal(normalizePhone('0899 663 377'), '0899663377');
});

test('seeds and preserves duplicate-safe state', () => {
    const state = seedState(createEmptyState(), ['https://car2u2025.mobile.bg/contacts'], ['0888883994']);
    assert.equal(state.processedDealers['https://car2u2025.mobile.bg'].status, 'seeded_sent');
    assert.equal(state.sentPhones['0888883994'], 'seeded');
});

test('calculates the remaining daily allowance', () => {
    const state = createEmptyState();
    state.daily['2026-08-13'] = { successful: 47 };
    assert.equal(remainingDailyAllowance(state, '2026-08-13', 50), 3);
    assert.equal(remainingDailyAllowance(state, '2026-08-13', 40), 0);
});

test('builds a stable date key in the selected timezone', () => {
    assert.equal(dateKey('Europe/Berlin', new Date('2026-08-12T22:30:00Z')), '2026-08-13');
});

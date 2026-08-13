export function normalizeDealerUrl(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        if (!host.endsWith('.mobile.bg') || host === 'mobile.bg') return null;
        return `https://${host}`;
    } catch {
        return null;
    }
}

export function normalizePhone(value = '') {
    let digits = String(value).replace(/\D/g, '');
    if (digits.startsWith('359') && digits.length === 12) digits = `0${digits.slice(3)}`;
    return digits;
}

export function dateKey(timeZone, date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

export function createEmptyState() {
    return {
        version: 1,
        processedDealers: {},
        sentPhones: {},
        daily: {},
        updatedAt: null,
    };
}

export function seedState(state, dealerUrls = [], phones = []) {
    const seededAt = new Date().toISOString();
    for (const rawUrl of dealerUrls) {
        const url = normalizeDealerUrl(rawUrl);
        if (!url || state.processedDealers[url]) continue;
        state.processedDealers[url] = { status: 'seeded_sent', processedAt: seededAt };
    }
    for (const rawPhone of phones) {
        const phone = normalizePhone(rawPhone);
        if (phone && !state.sentPhones[phone]) state.sentPhones[phone] = 'seeded';
    }
    return state;
}

export function remainingDailyAllowance(state, key, limit) {
    const used = Number(state.daily[key]?.successful || 0);
    return Math.max(0, limit - used);
}

export function redactError(error) {
    return String(error?.message || error || 'Unknown error').slice(0, 500);
}

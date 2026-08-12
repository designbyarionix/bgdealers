// v9: allow no-body API test runs without duplicating the user's Actor input.
// For a no-input run only, load the INPUT object from the most recent previous
// run of this same Actor, then override only safe test controls. Explicit input
// always passes through unchanged.

import { Actor } from 'apify';

const originalGetInput = Actor.getInput.bind(Actor);
let inputPromise;

async function loadPreviousInput() {
    const actorId = process.env.APIFY_ACTOR_ID;
    const currentRunId = process.env.APIFY_ACTOR_RUN_ID;
    const auth = process.env.APIFY_TOKEN;
    if (!actorId || !auth) throw new Error('Actor runtime API context is unavailable');

    const headers = { Authorization: `Bearer ${auth}`, Accept: 'application/json' };
    const runsRes = await fetch(`https://api.apify.com/v2/actors/${encodeURIComponent(actorId)}/runs?desc=1&limit=20`, { headers });
    if (!runsRes.ok) throw new Error(`Could not list previous runs (${runsRes.status})`);
    const runsJson = await runsRes.json();
    const runs = runsJson?.data?.items || [];

    for (const run of runs) {
        if (!run?.id || run.id === currentRunId || !run.defaultKeyValueStoreId) continue;
        const inputRes = await fetch(`https://api.apify.com/v2/key-value-stores/${encodeURIComponent(run.defaultKeyValueStoreId)}/records/INPUT`, { headers });
        if (!inputRes.ok) continue;
        const value = await inputRes.json().catch(() => null);
        if (!value || typeof value !== 'object' || Object.keys(value).length === 0) continue;
        console.log(`INFO  [API bootstrap] Using previous Actor input from run ${run.id}; values are not logged.`);
        return value;
    }
    throw new Error('No reusable previous Actor input found');
}

async function resolveInput() {
    const current = (await originalGetInput()) ?? {};
    if (current && typeof current === 'object' && Object.keys(current).length > 0) return current;

    console.log('INFO  [API bootstrap] No request body; preparing one-dealer diagnostic run from previous Actor input.');
    const previous = await loadPreviousInput();
    return {
        ...previous,
        mode: 'send',
        dealerUrls: ['https://atlanticdrive.mobile.bg'],
        submitContactForm: true,
        skipAlreadyContacted: false,
        resetContactedHistory: false,
        maxDealers: 1,
        maxListingPages: 1,
        maxBrowserConcurrency: 1,
        debugSaveCaptcha: false,
        formSubmitTimeoutMs: Math.max(120000, Number(previous.formSubmitTimeoutMs || 0)),
    };
}

Actor.getInput = async () => {
    if (!inputPromise) inputPromise = resolveInput();
    return await inputPromise;
};

await import('./main-v8.js');

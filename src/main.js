import { Actor, log } from 'apify';
import { chromium } from 'playwright';
import {
    createEmptyState,
    dateKey,
    normalizeDealerUrl,
    normalizePhone,
    redactError,
    remainingDailyAllowance,
    seedState,
} from './lib.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function twoCaptchaRequest(path, payload) {
    const response = await fetch(`https://api.2captcha.com/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json();
    if (!response.ok || result.errorId) {
        throw new Error(`2Captcha ${path}: ${result.errorCode || response.status} ${result.errorDescription || ''}`.trim());
    }
    return result;
}

async function solveImageCaptcha(apiKey, imageBuffer) {
    const created = await twoCaptchaRequest('createTask', {
        clientKey: apiKey,
        task: {
            type: 'ImageToTextTask',
            body: imageBuffer.toString('base64'),
            phrase: false,
            case: true,
            numeric: 0,
            math: false,
            minLength: 6,
            maxLength: 6,
            comment: 'Enter all 6 characters exactly. Uppercase and lowercase matter.',
        },
        languagePool: 'en',
    });

    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
        await sleep(5_000);
        const result = await twoCaptchaRequest('getTaskResult', {
            clientKey: apiKey,
            taskId: created.taskId,
        });
        if (result.status === 'ready') return result.solution.text.trim();
    }
    throw new Error('2Captcha timed out after 150 seconds');
}

async function discoverDealers(page, maxPages, alreadyProcessed, candidateTarget) {
    const dealers = [];
    const seen = new Set();

    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
        const url = pageNumber === 1
            ? 'https://www.mobile.bg/dealers'
            : `https://www.mobile.bg/dealers/p-${pageNumber}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });

        const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((link) => link.href));
        let newOnPage = 0;
        for (const href of hrefs) {
            const dealerUrl = normalizeDealerUrl(href);
            if (!dealerUrl || seen.has(dealerUrl)) continue;
            seen.add(dealerUrl);
            newOnPage += 1;
            if (!alreadyProcessed[dealerUrl]) dealers.push(dealerUrl);
        }

        log.info(`Scanned dealer page ${pageNumber}`, { candidates: dealers.length });
        if (newOnPage === 0 || dealers.length >= candidateTarget) break;
    }
    return dealers;
}

async function readDealerIdentity(page, dealerUrl) {
    await page.goto(`${dealerUrl}/contacts`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const hasForm = await page.locator('input[name="s0"], textarea[name="s3"]').count();
    if (!hasForm) throw new Error('Contact form is missing');

    const dealerName = (await page.locator('h1').first().textContent() || dealerUrl)
        .replace(/^Контакти\s*-\s*/i, '')
        .trim();
    const bodyText = await page.locator('body').innerText();
    const phoneMatch = bodyText.match(/Контакти с нас[\s\S]{0,160}?(?:\+359|0)[\d\s,-]{8,}/i);
    const phone = normalizePhone(phoneMatch?.[0] || '');
    return { dealerName, phone };
}

async function submitDealerForm(page, input) {
    await page.locator('input[name="s0"]').fill(input.senderName);
    await page.locator('input[name="s2"]').fill(input.senderPhone);
    await page.locator('input[name="s1"]').fill(input.senderEmail);
    await page.locator('textarea[name="s3"]').fill(input.message);
    await page.locator('input[name="accept2"]').check();

    for (let attempt = 1; attempt <= input.maxCaptchaAttempts; attempt += 1) {
        const captcha = page.locator('img[alt="captcha"]').first();
        await captcha.waitFor({ state: 'visible', timeout: 15_000 });
        const captchaPng = await captcha.screenshot({ type: 'png' });
        const solution = await solveImageCaptcha(input.twoCaptchaApiKey, captchaPng);

        await page.locator('input[name="s4"]').fill(solution);
        await page.getByText('ИЗПРАТИ ЗАПИТВАНЕТО', { exact: true }).click();
        await page.waitForTimeout(1_200);

        const text = await page.locator('body').innerText();
        if (text.includes('Запитването е изпратено.')) return { success: true, attempts: attempt };
        if (!text.includes('ГРЕШЕН КОД.')) {
            throw new Error(`Unexpected form response: ${text.slice(0, 250)}`);
        }
        log.warning(`CAPTCHA rejected; retrying (${attempt}/${input.maxCaptchaAttempts})`);
    }
    return { success: false, reason: 'captcha_rejected' };
}

await Actor.init();

const input = {
    sendMessages: false,
    senderName: 'Иван Димитров',
    senderPhone: '0888008210',
    senderEmail: 'info@arionix.de',
    dailySuccessfulLimit: 50,
    maxDealerPages: 190,
    delayBetweenDealersMs: 15_000,
    maxCaptchaAttempts: 2,
    timeZone: 'Europe/Berlin',
    stateStoreName: 'mobile-bg-outreach-state',
    initialProcessedDealerUrls: [],
    initialProcessedPhones: [],
    initialSuccessfulDate: '',
    initialSuccessfulCount: 0,
    ...(await Actor.getInput() || {}),
};

if (input.sendMessages && !input.twoCaptchaApiKey) {
    throw new Error('twoCaptchaApiKey is required when sendMessages is enabled');
}

const store = await Actor.openKeyValueStore(input.stateStoreName);
const state = seedState(
    (await store.getValue('STATE')) || createEmptyState(),
    input.initialProcessedDealerUrls,
    input.initialProcessedPhones,
);
const today = dateKey(input.timeZone);
state.daily[today] ||= {
    successful: input.initialSuccessfulDate === today
        ? Number(input.initialSuccessfulCount || 0)
        : 0,
};
const allowance = remainingDailyAllowance(state, today, input.dailySuccessfulLimit);

if (allowance === 0) {
    log.info('Daily successful-message limit is already reached', { today });
    await Actor.setValue('OUTPUT', { today, allowance: 0, successful: 0, message: 'Daily limit reached' });
    await Actor.exit();
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
    locale: 'bg-BG',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36',
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

let successfulThisRun = 0;
let scannedThisRun = 0;
const candidateTarget = Math.max(allowance * 4, 100);

try {
    const candidates = await discoverDealers(
        page,
        input.maxDealerPages,
        state.processedDealers,
        candidateTarget,
    );

    for (const dealerUrl of candidates) {
        if (successfulThisRun >= allowance) break;
        scannedThisRun += 1;

        const result = {
            dealerUrl,
            runAt: new Date().toISOString(),
            mode: input.sendMessages ? 'send' : 'dry_run',
        };

        try {
            const identity = await readDealerIdentity(page, dealerUrl);
            Object.assign(result, identity);

            if (identity.phone && state.sentPhones[identity.phone]) {
                result.status = 'skipped_duplicate_phone';
                result.duplicateOf = state.sentPhones[identity.phone];
                state.processedDealers[dealerUrl] = {
                    status: result.status,
                    phone: identity.phone,
                    processedAt: result.runAt,
                };
                await Actor.pushData(result);
                await store.setValue('STATE', { ...state, updatedAt: new Date().toISOString() });
                continue;
            }

            if (!input.sendMessages) {
                result.status = 'dry_run_ready';
                await Actor.pushData(result);
                if (scannedThisRun >= allowance) break;
                continue;
            }

            const submitted = await submitDealerForm(page, input);
            result.status = submitted.success ? 'sent' : submitted.reason;
            result.captchaAttempts = submitted.attempts || input.maxCaptchaAttempts;

            if (submitted.success) {
                successfulThisRun += 1;
                state.daily[today].successful += 1;
                state.processedDealers[dealerUrl] = {
                    status: 'sent',
                    dealerName: identity.dealerName,
                    phone: identity.phone,
                    processedAt: result.runAt,
                };
                if (identity.phone) state.sentPhones[identity.phone] = dealerUrl;
            }
            await Actor.pushData(result);
            await store.setValue('STATE', { ...state, updatedAt: new Date().toISOString() });
        } catch (error) {
            result.status = 'failed';
            result.error = redactError(error);
            await Actor.pushData(result);
            log.error(`Dealer failed: ${dealerUrl}`, { error: result.error });
        }

        if (successfulThisRun < allowance) await sleep(input.delayBetweenDealersMs);
    }
} finally {
    state.updatedAt = new Date().toISOString();
    await store.setValue('STATE', state);
    await browser.close();
}

const output = {
    today,
    sendMessages: input.sendMessages,
    successfulThisRun,
    successfulToday: state.daily[today].successful,
    scannedThisRun,
    remainingToday: remainingDailyAllowance(state, today, input.dailySuccessfulLimit),
    stateStoreName: input.stateStoreName,
};
await Actor.setValue('OUTPUT', output);
log.info('Run finished', output);
await Actor.exit();

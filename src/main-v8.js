// v8 runtime layer for Mobile.bg.
// In send mode, discover dealer URLs before main-v7 starts so a transient 5xx
// from /dealers cannot make the Actor silently finish with zero targets.
// Discovery uses spaced HTTP retries, a Playwright fallback, and a persistent
// cache of the last successful dealer list. The paid 2Captcha-only form flow
// remains unchanged in main-v7/main-v5.

import { Actor } from 'apify';
import playwright from 'playwright';

const originalGetInput = Actor.getInput.bind(Actor);
let resolvedInputPromise = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildStartUrl(baseUrl, page) {
    if (!page || page <= 1) return baseUrl;
    const trimmed = String(baseUrl || 'https://www.mobile.bg/dealers').replace(/\/+$/, '');
    const withoutExistingPage = trimmed.replace(/\/p-\d+$/i, '');
    return `${withoutExistingPage}/p-${page}`;
}

function normalizeDealerUrl(raw) {
    try {
        const url = new URL(raw);
        const match = url.hostname.match(/^([a-z0-9-]+)\.mobile\.bg$/i);
        if (!match || match[1].toLowerCase() === 'www') return null;
        return `https://${match[1].toLowerCase()}.mobile.bg`;
    } catch {
        return null;
    }
}

function extractDealerUrlsFromHtml(html) {
    const result = [];
    const seen = new Set();
    const text = String(html || '');
    const re = /href=["'](https?:\/\/([a-z0-9-]+)\.mobile\.bg\/?(?:[^"']*)?)["']/gi;
    for (const match of text.matchAll(re)) {
        const dealer = normalizeDealerUrl(match[1]);
        if (!dealer || seen.has(dealer)) continue;
        seen.add(dealer);
        result.push(dealer);
    }
    return result;
}

function findNextListingUrl(html, currentUrl) {
    const text = String(html || '');
    const hrefs = [...text.matchAll(/href=["']([^"']*\/dealers\/p-(\d+)[^"']*)["']/gi)]
        .map((m) => ({ href: m[1], page: Number(m[2]) }))
        .filter((x) => Number.isFinite(x.page));
    if (!hrefs.length) return null;

    const currentMatch = String(currentUrl).match(/\/dealers\/p-(\d+)/i);
    const currentPage = currentMatch ? Number(currentMatch[1]) : 1;
    const future = hrefs.filter((x) => x.page > currentPage).sort((a, b) => a.page - b.page)[0];
    if (!future) return null;
    try { return new URL(future.href, currentUrl).toString(); } catch { return null; }
}

async function fetchListingPageWithRetry(url) {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(url, {
                redirect: 'follow',
                headers: {
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'accept-language': 'bg-BG,bg;q=0.9,en;q=0.7',
                    'cache-control': 'no-cache',
                    pragma: 'no-cache',
                },
            });
            if (response.ok) {
                const html = await response.text();
                const dealers = extractDealerUrlsFromHtml(html);
                if (dealers.length > 0) {
                    console.log(`INFO  [Dealer discovery] HTTP success ${response.status}: ${dealers.length} dealer URLs from ${url}`);
                    return { html, dealers };
                }
                console.log(`WARN  [Dealer discovery] HTTP ${response.status}, but no dealer URLs found on ${url}`);
            } else {
                console.log(`WARN  [Dealer discovery] HTTP attempt ${attempt}/${attempts} returned ${response.status} for ${url}`);
            }
        } catch (err) {
            console.log(`WARN  [Dealer discovery] HTTP attempt ${attempt}/${attempts} failed for ${url}: ${err.message}`);
        }

        if (attempt < attempts) {
            const delay = Math.min(12000, 1500 * (2 ** (attempt - 1)));
            await sleep(delay);
        }
    }
    return null;
}

async function discoverWithBrowser(startUrl, maxPages, maxDealers) {
    let browser;
    try {
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox'],
        });
        const context = await browser.newContext({
            locale: 'bg-BG',
            viewport: { width: 1365, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        });
        const page = await context.newPage();
        const all = [];
        const seen = new Set();
        let currentUrl = startUrl;
        let visited = 0;

        while (currentUrl) {
            if (maxPages > 0 && visited >= maxPages) break;
            if (maxDealers > 0 && all.length >= maxDealers) break;
            visited += 1;

            let loaded = false;
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                try {
                    const response = await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    const status = response?.status?.() ?? 0;
                    if (status >= 200 && status < 400) {
                        loaded = true;
                        break;
                    }
                    console.log(`WARN  [Dealer discovery] Browser attempt ${attempt}/3 returned ${status} for ${currentUrl}`);
                } catch (err) {
                    console.log(`WARN  [Dealer discovery] Browser attempt ${attempt}/3 failed for ${currentUrl}: ${err.message}`);
                }
                await sleep(2500 * attempt);
            }
            if (!loaded) break;

            const pageDealers = await page.locator('a[href]').evaluateAll((els) => {
                const output = [];
                for (const el of els) {
                    const href = el.href || '';
                    try {
                        const url = new URL(href);
                        const match = url.hostname.match(/^([a-z0-9-]+)\.mobile\.bg$/i);
                        if (!match || match[1].toLowerCase() === 'www') continue;
                        output.push(`https://${match[1].toLowerCase()}.mobile.bg`);
                    } catch {}
                }
                return [...new Set(output)];
            });

            for (const dealer of pageDealers) {
                if (seen.has(dealer)) continue;
                seen.add(dealer);
                all.push(dealer);
                if (maxDealers > 0 && all.length >= maxDealers) break;
            }

            if (maxDealers > 0 && all.length >= maxDealers) break;
            const nextHref = await page.locator('a').evaluateAll((els) => {
                const links = els.map((el) => ({ text: (el.innerText || '').trim().toLowerCase(), href: el.href || '' }));
                const byText = links.find((x) => x.text === 'напред' && /\/dealers\/p-\d+/i.test(x.href));
                if (byText) return byText.href;
                const candidates = links
                    .filter((x) => /\/dealers\/p-(\d+)/i.test(x.href))
                    .map((x) => ({ href: x.href, page: Number(x.href.match(/\/dealers\/p-(\d+)/i)?.[1] || 0) }))
                    .filter((x) => x.page > 0)
                    .sort((a, b) => a.page - b.page);
                return candidates[0]?.href || null;
            }).catch(() => null);

            if (!nextHref || nextHref === currentUrl) break;
            currentUrl = nextHref;
        }

        await context.close().catch(() => null);
        console.log(`INFO  [Dealer discovery] Browser fallback found ${all.length} dealer URLs.`);
        return all;
    } catch (err) {
        console.log(`WARN  [Dealer discovery] Browser fallback failed: ${err.message}`);
        return [];
    } finally {
        await browser?.close().catch(() => null);
    }
}

async function discoverDealerUrls(input) {
    const startUrl = buildStartUrl(input.startUrl || 'https://www.mobile.bg/dealers', Number(input.startPage || 1));
    const maxPages = Number(input.maxListingPages || 0);
    const maxDealers = Number(input.maxDealers || 0);
    const all = [];
    const seen = new Set();
    let currentUrl = startUrl;
    let visited = 0;

    while (currentUrl) {
        if (maxPages > 0 && visited >= maxPages) break;
        if (maxDealers > 0 && all.length >= maxDealers) break;
        visited += 1;

        const result = await fetchListingPageWithRetry(currentUrl);
        if (!result) break;
        for (const dealer of result.dealers) {
            if (seen.has(dealer)) continue;
            seen.add(dealer);
            all.push(dealer);
            if (maxDealers > 0 && all.length >= maxDealers) break;
        }
        if (maxDealers > 0 && all.length >= maxDealers) break;
        currentUrl = findNextListingUrl(result.html, currentUrl);
    }

    if (all.length > 0) return all;
    return await discoverWithBrowser(startUrl, maxPages, maxDealers);
}

async function resolveInput() {
    const input = (await originalGetInput()) ?? {};
    const mode = input.mode || 'scrape';
    const supplied = Array.isArray(input.dealerUrls) ? input.dealerUrls.filter(Boolean) : [];

    // Explicit dealerUrls always win and need no discovery.
    if (mode !== 'send' || supplied.length > 0) return input;

    console.log('INFO  [Dealer discovery] send mode without dealerUrls: resolving targets before main crawler starts.');
    let discovered = await discoverDealerUrls(input);

    const store = await Actor.openKeyValueStore('bgdealers-dealer-cache');
    if (discovered.length > 0) {
        const fullForCache = [...new Set(discovered)];
        await store.setValue('lastSuccessfulDealerUrls', {
            savedAt: new Date().toISOString(),
            urls: fullForCache,
        });
        console.log(`INFO  [Dealer discovery] using ${discovered.length} freshly discovered dealer URLs.`);
    } else {
        const cached = await store.getValue('lastSuccessfulDealerUrls');
        const cachedUrls = Array.isArray(cached?.urls) ? cached.urls.filter(Boolean) : [];
        if (cachedUrls.length > 0) {
            discovered = cachedUrls;
            console.log(`WARN  [Dealer discovery] Mobile.bg listing unavailable; using ${cachedUrls.length} cached dealer URLs from ${cached.savedAt || 'previous run'}.`);
        }
    }

    if (Number(input.maxDealers || 0) > 0) discovered = discovered.slice(0, Number(input.maxDealers));

    if (discovered.length === 0) {
        console.log('ERROR [Dealer discovery] Could not resolve any dealer URLs via HTTP, browser fallback, or cache.');
        return input;
    }

    // Inject targets so main-v2 skips CheerioCrawler /dealers entirely in send mode.
    return { ...input, dealerUrls: discovered };
}

Actor.getInput = async () => {
    if (!resolvedInputPromise) resolvedInputPromise = resolveInput();
    return await resolvedInputPromise;
};

await import('./main-v7.js');

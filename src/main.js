import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import playwright from 'playwright';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrl = 'https://www.mobile.bg/dealers',
    maxListingPages = 0, // 0 = без лимит
    maxDealers = 0, // 0 = без лимит
    maxConcurrency = 10,
    findOfficialWebsite = false,
    scrapeEmails = false,
    googleSearchCountryCode = 'bg',
    googleSearchLanguageCode = 'bg',
    // New options for contact form automation
    submitContactForm = false,
    contactFormData = {},
    captchaApiKey = null,
    formSubmitTimeoutMs = 60000,
    // mode: 'scrape' (default) = collect data; 'send' = only submit contact forms;
    // 'both' = scrape then submit forms.
    mode = 'scrape',
    // Optional: supply explicit list of dealer base URLs to operate on instead of crawling
    dealerUrls = [],
} = input;

/**
 * ---------------------------------------------------------------------------
 * ФАЗА 1: Обхождаме https://www.mobile.bg/dealers (и пагинацията му) и
 * събираме уникалните под-домейни на дилърите, напр. https://atlanticdrive.mobile.bg
 * ---------------------------------------------------------------------------
 */
const dealerLinks = new Map(); // url -> name (както е показано в списъка)
let listingPagesVisited = 0;

const listingCrawler = new CheerioCrawler({
    maxConcurrency: 3,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ request, $, enqueueLinks, log: reqLog }) {
        listingPagesVisited += 1;
        reqLog.info(`[Списък] ${request.url} (страница ${listingPagesVisited})`);

        // Всеки дилър в списъка има линк към собствения си под-домейн
        // (напр. https://atlanticdrive.mobile.bg), който се среща по няколко
        // пъти на страницата (име, лого, "Виж всички обяви"). Събираме ги
        // уникално по домейн.
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;

            const m = href.match(/^https?:\/\/([a-z0-9-]+)\.mobile\.bg\/?(?:[?#].*)?$/i);
            if (!m) return;

            const subdomain = m[1].toLowerCase();
            if (subdomain === 'www') return; // прескачаме самия www.mobile.bg

            const dealerUrl = `https://${subdomain}.mobile.bg`;
            const text = $(el).text().trim();

            if (!dealerLinks.has(dealerUrl)) {
                dealerLinks.set(dealerUrl, text || null);
            } else if (text && !dealerLinks.get(dealerUrl)) {
                // допълваме името, ако предният път сме хванали линк без текст (напр. лого)
                dealerLinks.set(dealerUrl, text);
            }
        });

        if (maxListingPages > 0 && listingPagesVisited >= maxListingPages) {
            reqLog.info('Достигнат е лимитът за страници от списъка, спирам пагинацията.');
            return;
        }

        // Пагинация: търсим линк "Напред" или /dealers/p-N
        let nextHref = $('a')
            .filter((_, el) => $(el).text().trim().toLowerCase() === 'напред')
            .attr('href');

        if (!nextHref) {
            nextHref = $('a[href*="/dealers/p-"]')
                .attr('href');
        }

        if (nextHref) {
            const nextUrl = new URL(nextHref, request.url).toString();
            await enqueueLinks({ urls: [nextUrl] });
        }
    },
    failedRequestHandler({ request, log: reqLog }) {
        reqLog.warning(`Провалена страница от списъка: ${request.url}`);
    },
});

// Decide whether to crawl the listings or use provided `dealerUrls`.
if (mode === 'scrape' || mode === 'both' || (mode === 'send' && (!dealerUrls || dealerUrls.length === 0))) {
    await listingCrawler.run([startUrl]);
    log.info(`Намерени ${dealerLinks.size} уникални дилъра в ${listingPagesVisited} страници от списъка.`);
}

let dealerEntries = [];
if (dealerUrls && dealerUrls.length > 0) {
    dealerEntries = dealerUrls.map((u) => [u.replace(/\/+$/, ''), null]);
} else {
    dealerEntries = [...dealerLinks.entries()]; // [ [url, name], ... ]
}
if (maxDealers > 0) {
    dealerEntries = dealerEntries.slice(0, maxDealers);
}

/**
 * ---------------------------------------------------------------------------
 * ФАЗА 2: За всеки дилър отваряме {dealerUrl}/contacts (бутонът "Контакти")
 * и извличаме телефон, адрес и дата на регистрация.
 * ---------------------------------------------------------------------------
 */
const PHONE_REGEX = /(\+359[\s.-]?\d{1,3}[\s.-]?\d{3}[\s.-]?\d{3,4}|0\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4})/g;

function cleanPhone(raw) {
    return raw.replace(/[\s.-]/g, '');
}

function extractBetween(text, startMarker, endMarkers) {
    const startIdx = text.indexOf(startMarker);
    if (startIdx === -1) return null;
    let sliceStart = startIdx + startMarker.length;
    let sliceEnd = text.length;
    for (const marker of endMarkers) {
        const idx = text.indexOf(marker, sliceStart);
        if (idx !== -1 && idx < sliceEnd) sliceEnd = idx;
    }
    const value = text.slice(sliceStart, sliceEnd).trim();
    return value || null;
}

const dealerResults = [];

const contactsCrawler = new CheerioCrawler({
    maxConcurrency,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ request, $, log: reqLog }) {
        const { dealerUrl, listedName } = request.userData;

        const pageText = $.root().text().replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();

        // Име на дилъра: заглавието на страницата е "Контакти - <Име>"
        let dealerName = $('h1').first().text().trim();
        dealerName = dealerName.replace(/^Контакти\s*-\s*/i, '').trim();
        if (!dealerName) dealerName = listedName || null;

        const phonesRaw = pageText.match(PHONE_REGEX) || [];
        const phones = [...new Set(phonesRaw.map(cleanPhone))];

        const address = extractBetween(pageText, 'Адрес:', ['Кореспондентски адрес:', 'Обяви', 'Изпратете', 'За да се свържете', 'Powered by']);
        const correspondenceAddress = extractBetween(
            pageText,
            'Кореспондентски адрес:',
            ['Обяви', 'Изпратете', 'За да се свържете', 'Powered by'],
        );

        // Защитна мярка: ако маркерите липсват, не позволяваме адресът да
        // "погълне" целия остатък на страницата.
        const trimTo200 = (v) => (v && v.length > 200 ? `${v.slice(0, 200).trim()}…` : v);

        const memberSinceMatch = pageText.match(/в mobile\.bg\s+от\s+(\d{4})\s*г\./i);
        const memberSince = memberSinceMatch ? memberSinceMatch[1] : null;

        const result = {
            dealerName,
            dealerUrl,
            contactsUrl: request.url,
            phones,
            address: trimTo200(address),
            correspondenceAddress: trimTo200(correspondenceAddress),
            memberSince,
            officialWebsite: null,
            emails: [],
            scrapedAt: new Date().toISOString(),
        };

        if (phones.length === 0) {
            reqLog.warning(`Не е намерен телефон за ${dealerUrl} — записвам все пак с празен масив.`);
        }

        dealerResults.push(result);
    },
    failedRequestHandler({ request, log: reqLog }) {
        reqLog.warning(`Провалена страница с контакти: ${request.url}`);
    },
});

if (mode === 'scrape' || mode === 'both') {
    await contactsCrawler.run(
        dealerEntries.map(([dealerUrl, listedName]) => ({
            url: `${dealerUrl}/contacts`,
            userData: { dealerUrl, listedName },
        })),
    );

    log.info(`Извлечени контакти за ${dealerResults.length} дилъра.`);
} else {
    // mode === 'send' and dealerEntries provided: prepare minimal dealerResults
    dealerResults = dealerEntries.map(([dealerUrl, listedName]) => ({
        dealerName: listedName || null,
        dealerUrl,
        contactsUrl: `${dealerUrl.replace(/\/+$/, '')}/contacts`,
        phones: [],
        address: null,
        correspondenceAddress: null,
        memberSince: null,
        officialWebsite: null,
        emails: [],
        scrapedAt: new Date().toISOString(),
    }));
    log.info(`Подготвени ${dealerResults.length} дилъра за подадени съобщения (режим send).`);
}

/**
 * ---------------------------------------------------------------------------
 * ФАЗА 3 (опционална): Търсене на официалния уебсайт на всеки дилър в Google.
 * Използваме готовия официален Apify актор "apify/google-search-scraper" —
 * не правим Google scraping от нулата.
 * ---------------------------------------------------------------------------
 */
const BLACKLISTED_DOMAINS = [
    'mobile.bg',
    'facebook.com',
    'instagram.com',
    'tiktok.com',
    'youtube.com',
    'linkedin.com',
    'olx.bg',
    'bazar.bg',
    'imot.bg',
    'auto.bg',
    'cars.bg',
    'google.com',
    'g.page',
    'goo.gl',
    'zlatnistranici.bg',
    'wikipedia.org',
    'apify.com',
];

function isBlacklisted(urlString) {
    try {
        const host = new URL(urlString).hostname.replace(/^www\./, '').toLowerCase();
        return BLACKLISTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
        return true; // невалиден URL -> третираме като неизползваем
    }
}

if (findOfficialWebsite && dealerResults.length > 0) {
    log.info('ФАЗА 3: Търсене на официални уебсайтове чрез apify/google-search-scraper…');

    const dealersWithName = dealerResults.filter((d) => d.dealerName);
    const queries = dealersWithName.map((d) => `"${d.dealerName}" автокъща`);

    try {
        const searchRun = await Actor.call('apify/google-search-scraper', {
            queries: queries.join('\n'),
            resultsPerPage: 10,
            maxPagesPerQuery: 1,
            countryCode: googleSearchCountryCode,
            languageCode: googleSearchLanguageCode,
        });

        const searchDataset = await Actor.openDataset(searchRun.defaultDatasetId, { forceCloud: true });
        const { items: searchItems } = await searchDataset.getData();

        // Мапваме резултата обратно към дилъра по точния текст на заявката.
        const queryToDealer = new Map();
        dealersWithName.forEach((d, i) => queryToDealer.set(queries[i], d));

        for (const item of searchItems) {
            const term = item?.searchQuery?.term;
            if (!term) continue;
            const dealer = queryToDealer.get(term);
            if (!dealer) continue;

            const organicResults = item.organicResults || [];
            const firstGood = organicResults.find((r) => r?.url && !isBlacklisted(r.url));
            if (firstGood) {
                dealer.officialWebsite = firstGood.url;
            }
        }

        const foundCount = dealerResults.filter((d) => d.officialWebsite).length;
        log.info(`Намерени официални уебсайтове за ${foundCount} от ${dealersWithName.length} дилъра.`);
    } catch (err) {
        log.warning(`Търсенето в Google се провали: ${err.message}. Продължавам без официални уебсайтове.`);
    }
}

/**
 * ---------------------------------------------------------------------------
 * ФАЗА 4 (опционална): Влизаме в намерения официален уебсайт и извличаме
 * имейл адреси (mailto: линкове + regex по видимия текст).
 * ---------------------------------------------------------------------------
 */
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const GENERIC_JUNK_EMAILS = new Set(['example@example.com', 'name@example.com', 'you@example.com']);

async function fetchHtml(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; DealerEmailBot/1.0)',
                Accept: 'text/html,application/xhtml+xml',
            },
            redirect: 'follow',
        });
        if (!res.ok) return null;
        return await res.text();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function extractEmailsFromHtml(html) {
    if (!html) return [];
    const mailtoMatches = [...html.matchAll(/mailto:([^"'\s?>]+)/gi)].map((m) => m[1]);
    const textMatches = html.match(EMAIL_REGEX) || [];
    const all = [...mailtoMatches, ...textMatches]
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && !GENERIC_JUNK_EMAILS.has(e) && !e.endsWith('.png') && !e.endsWith('.jpg'));
    return [...new Set(all)];
}

async function findContactPageUrl(baseUrl, html) {
    if (!html) return null;
    const hrefMatches = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
    // Първо търсим директно "контакти"/"contact", после падаме към "за нас"/"about"
    const candidate = hrefMatches.find((h) => /kontakt|contact/i.test(h))
        || hrefMatches.find((h) => /za-nas|about/i.test(h));
    if (!candidate) return null;
    try {
        return new URL(candidate, baseUrl).toString();
    } catch {
        return null;
    }
}

// -------------------------
// Playwright form filler + 2captcha support
// -------------------------

async function solveRecaptcha2(sitekey, pageUrl, apiKey, timeoutMs = 120000) {
    if (!apiKey) throw new Error('No 2captcha API key provided');
    const params = new URLSearchParams({
        key: apiKey,
        method: 'userrecaptcha',
        googlekey: sitekey,
        pageurl: pageUrl,
        json: '1',
    });
    const inRes = await fetch(`http://2captcha.com/in.php?${params.toString()}`);
    const inJson = await inRes.json();
    if (!inJson || inJson.status !== 1) throw new Error(`2captcha in.php error: ${JSON.stringify(inJson)}`);
    const requestId = inJson.request;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5000));
        const res = await fetch(`http://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`);
        const body = await res.json();
        if (body.status === 1 && body.request) return body.request;
        if (body.request && body.request.includes('ERROR')) throw new Error(`2captcha error: ${body.request}`);
    }
    throw new Error('2captcha timeout waiting for solution');
}

async function solveImageCaptcha2(imageBase64, apiKey, timeoutMs = 120000) {
    if (!apiKey) throw new Error('No 2captcha API key provided');

    const params = new URLSearchParams({
        method: 'base64',
        key: apiKey,
        body: imageBase64,
        json: '1',
    });

    const inRes = await fetch('http://2captcha.com/in.php', {
        method: 'POST',
        body: params,
    });
    const inJson = await inRes.json();
    if (!inJson || inJson.status !== 1) throw new Error(`2captcha in.php error: ${JSON.stringify(inJson)}`);
    const requestId = inJson.request;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5000));
        const res = await fetch(`http://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`);
        const body = await res.json();
        if (body.status === 1 && body.request) return body.request;
        if (body.request && body.request.includes('ERROR')) throw new Error(`2captcha error: ${body.request}`);
    }
    throw new Error('2captcha timeout waiting for image solution');
}

async function submitContactFormWithPlaywright(url, formData = {}, captchaApiKeyLocal = null, timeoutMs = 60000) {
    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Find the first form on the page
        const formHandle = await page.$('form');
        if (!formHandle) {
            await browser.close();
            return { submitted: false, reason: 'no-form-found' };
        }

        // Collect form fields (inputs + textareas)
        const fields = await page.$$eval('form input, form textarea, form select', (els) => els.map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.getAttribute('name'),
            id: el.id || null,
            placeholder: el.getAttribute('placeholder') || null,
            aria: el.getAttribute('aria-label') || null,
        })));

        function matchKey(meta) {
            if (!meta) return null;
            const v = `${meta.name || ''} ${meta.id || ''} ${meta.placeholder || ''} ${meta.aria || ''}`.toLowerCase();
            if (/name|fullname|contact/i.test(v)) return 'name';
            if (/email|e-?mail/i.test(v)) return 'email';
            if (/subject|title/i.test(v)) return 'subject';
            if (/message|msg|comment|description|note/i.test(v)) return 'message';
            return null;
        }

        // Fill fields using heuristics
        for (const meta of fields) {
            const key = matchKey(meta);
            if (!key) continue;
            const value = formData[key];
            if (!value) continue;
            // build selector
            const selectorParts = [];
            if (meta.name) selectorParts.push(`input[name="${meta.name}"]`, `textarea[name="${meta.name}"]`);
            if (meta.id) selectorParts.push(`#${meta.id}`);
            if (meta.placeholder) selectorParts.push(`input[placeholder="${meta.placeholder}"]`, `textarea[placeholder="${meta.placeholder}"]`);
            const selector = selectorParts.join(', ');
            try {
                await page.fill(selector, value.toString());
            } catch {
                // best-effort; ignore fill errors
            }
        }

        // Detect reCAPTCHA sitekey
        const sitekey = await page.$eval('[data-sitekey], .g-recaptcha', (el) => el.getAttribute('data-sitekey'),).catch(() => null);
        let captchaToken = null;
        if (sitekey) {
            if (!captchaApiKeyLocal) {
                await browser.close();
                return { submitted: false, reason: 'captcha-present-no-api-key' };
            }
            try {
                captchaToken = await solveRecaptcha2(sitekey, page.url(), captchaApiKeyLocal, Math.min(120000, timeoutMs));
                await page.evaluate((token) => {
                    let textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
                    if (!textarea) {
                        textarea = document.createElement('textarea');
                        textarea.name = 'g-recaptcha-response';
                        textarea.style.display = 'none';
                        document.body.appendChild(textarea);
                    }
                    textarea.value = token;
                }, captchaToken);
            } catch (err) {
                await browser.close();
                return { submitted: false, reason: `captcha-solve-failed: ${err.message}` };
            }
        }

        // Detect image-based captcha (simple distorted text image)
        const imgHandle = await page.$('img[src*="captcha"], img[class*="captcha"], img[id*="captcha"], img[alt*="captcha"], img[title*="captcha"]');
        if (imgHandle) {
            if (!captchaApiKeyLocal) {
                await browser.close();
                return { submitted: false, reason: 'image-captcha-present-no-api-key' };
            }
            try {
                const src = await imgHandle.getAttribute('src');
                const absolute = new URL(src, page.url()).toString();
                const ab = await fetch(absolute).then((r) => r.arrayBuffer());
                const base64 = Buffer.from(ab).toString('base64');
                const solved = await solveImageCaptcha2(base64, captchaApiKeyLocal, Math.min(120000, timeoutMs));
                // Try to find input for the captcha code and fill it
                const inputSelector = await page.$eval('input[name*="code"], input[name*="captcha"], input[placeholder*="код"], input[id*="code"], input[id*="captcha"]', (el) => el.getAttribute('name') || el.id || null).catch(() => null);
                if (inputSelector) {
                    // prefer name attribute selector if present
                    const sel = inputSelector.includes(' ') || inputSelector.includes('#') ? `[name="${inputSelector}"]` : `input[name="${inputSelector}"]`;
                    try { await page.fill(sel, solved.toString()); } catch {}
                } else {
                    // fallback: fill first input near the img
                    await page.evaluate((val) => {
                        const img = document.querySelector('img[src*="captcha"], img[class*="captcha"], img[id*="captcha"], img[alt*="captcha"], img[title*="captcha"]');
                        if (!img) return;
                        // look for input sibling
                        const input = img.parentElement.querySelector('input') || document.querySelector('input');
                        if (input) input.value = val;
                    }, solved.toString());
                }
            } catch (err) {
                await browser.close();
                return { submitted: false, reason: `image-captcha-solve-failed: ${err.message}` };
            }
        }

        // Submit the form: try to click submit button or submit programmatically
        const clicked = await page.$eval('form', (f) => {
            const btn = f.querySelector('button[type="submit"], input[type="submit"]');
            if (btn) { btn.click(); return true; }
            try { f.submit(); return true; } catch { return false; }
        }).catch(() => false);

        // Wait for navigation or a short delay
        try {
            await Promise.race([
                page.waitForNavigation({ timeout: 5000 }).catch(() => null),
                new Promise((r) => setTimeout(r, 3000)),
            ]);
        } catch {}

        await browser.close();
        return { submitted: true, clicked: !!clicked, captchaToken: captchaToken || null };
    } catch (err) {
        await browser.close();
        return { submitted: false, reason: err.message };
    }
}

// Прост concurrency limiter, за да не заливаме десетки различни външни сайтове наведнъж.
async function runWithConcurrency(items, limit, worker) {
    const queue = [...items];
    const runners = Array.from({ length: Math.max(1, limit) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            await worker(item);
        }
    });
    await Promise.all(runners);
}

if (findOfficialWebsite && scrapeEmails) {
    const dealersWithWebsite = dealerResults.filter((d) => d.officialWebsite);
    log.info(`ФАЗА 4: Извличане на имейли от ${dealersWithWebsite.length} официални уебсайта…`);

    await runWithConcurrency(dealersWithWebsite, 5, async (dealer) => {
        const homeHtml = await fetchHtml(dealer.officialWebsite);
        let emails = extractEmailsFromHtml(homeHtml);

        if (emails.length === 0) {
            const contactUrl = await findContactPageUrl(dealer.officialWebsite, homeHtml);
            if (contactUrl) {
                const contactHtml = await fetchHtml(contactUrl);
                emails = extractEmailsFromHtml(contactHtml);
            }
        }

        dealer.emails = emails;
    });

    const foundEmails = dealerResults.filter((d) => d.emails.length > 0).length;
    log.info(`Намерени имейли за ${foundEmails} дилъра.`);
}

// ---------------------------------------------------------------------------
// Optional Phase: submit contact forms on the dealers' contact pages
// ---------------------------------------------------------------------------
if (submitContactForm && dealerResults.length > 0 && (mode === 'send' || mode === 'both')) {
    log.info(`ФАЗА: Попълване на контактни форми за ${dealerResults.length} дилъра…`);

    await runWithConcurrency(dealerResults, Math.max(1, Math.floor(maxConcurrency / 2)), async (dealer) => {
        try {
            const res = await submitContactFormWithPlaywright(dealer.contactsUrl, contactFormData, captchaApiKey, formSubmitTimeoutMs);
            dealer.contactForm = res;
        } catch (err) {
            dealer.contactForm = { submitted: false, reason: err.message };
        }
    });

    const submittedCount = dealerResults.filter((d) => d.contactForm && d.contactForm.submitted).length;
    log.info(`Успешно подадени форми за ${submittedCount} дилъра.`);
}

/**
 * ---------------------------------------------------------------------------
 * Финално записване в Dataset.
 * ---------------------------------------------------------------------------
 */
await Actor.pushData(dealerResults);

log.info('Готово.');

await Actor.exit();

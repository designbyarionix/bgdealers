import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';
import playwright from 'playwright';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import fs from 'fs/promises';

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrl = 'https://www.mobile.bg/dealers',
    startPage = 1,
    maxListingPages = 0,
    maxDealers = 0,
    maxConcurrency = 10,
    maxBrowserConcurrency = 2,
    findOfficialWebsite = false,
    scrapeEmails = false,
    googleSearchCountryCode = 'bg',
    googleSearchLanguageCode = 'bg',
    submitContactForm = false,
    skipAlreadyContacted = true,
    resetContactedHistory = false,
    contactName = '',
    contactPhone = '',
    contactEmail = '',
    contactSubject = '',
    contactMessage = '',
    captchaApiKey = null,
    formSubmitTimeoutMs = 60000,
    debugSaveCaptcha = false,
    mode = 'scrape',
    dealerUrls = [],
} = input;

const contactFormData = {
    name: contactName,
    phone: contactPhone,
    email: contactEmail,
    subject: contactSubject,
    message: contactMessage,
};

function buildStartUrl(baseUrl, page) {
    if (!page || page <= 1) return baseUrl;
    const trimmed = baseUrl.replace(/\/+$/, '');
    const withoutExistingPage = trimmed.replace(/\/p-\d+$/i, '');
    return `${withoutExistingPage}/p-${page}`;
}

const effectiveStartUrl = buildStartUrl(startUrl, startPage);

const contactedStore = await Actor.openKeyValueStore('bgdealers-contacted-urls');
let contactedUrls = new Set();
if (resetContactedHistory) {
    await contactedStore.setValue('contactedUrls', []);
    log.info('Историята на вече контактуваните дилъри е изчистена за този run.');
} else {
    const storedContacted = await contactedStore.getValue('contactedUrls');
    if (Array.isArray(storedContacted)) contactedUrls = new Set(storedContacted);
    if (contactedUrls.size > 0) {
        log.info(`Заредена история: ${contactedUrls.size} дилъра вече са контактувани в предходни run-ове.`);
    }
}

const dealerLinks = new Map();
let listingPagesVisited = 0;
const visitedListingUrls = new Set();

function listingPageNumber(url) {
    const m = url.match(/\/dealers\/p-(\d+)/i);
    return m ? Number(m[1]) : 1;
}

const listingCrawler = new CheerioCrawler({
    maxConcurrency: 3,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ request, $, enqueueLinks, log: reqLog }) {
        if (visitedListingUrls.has(request.url)) return;
        visitedListingUrls.add(request.url);
        listingPagesVisited += 1;
        reqLog.info(`[Списък] ${request.url} (обходена страница ${listingPagesVisited})`);

        $('a[href]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const m = href.match(/^https?:\/\/([a-z0-9-]+)\.mobile\.bg\/?(?:[?#].*)?$/i);
            if (!m) return;
            const subdomain = m[1].toLowerCase();
            if (subdomain === 'www') return;
            const dealerUrl = `https://${subdomain}.mobile.bg`;
            const text = $(el).text().trim();
            if (!dealerLinks.has(dealerUrl)) dealerLinks.set(dealerUrl, text || null);
            else if (text && !dealerLinks.get(dealerUrl)) dealerLinks.set(dealerUrl, text);
        });

        if (maxListingPages > 0 && listingPagesVisited >= maxListingPages) {
            reqLog.info('Достигнат е лимитът за страници от списъка, спирам пагинацията.');
            return;
        }

        const currentPage = listingPageNumber(request.url);
        const candidates = [];
        $('a[href*="/dealers/p-"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            try {
                const nextUrl = new URL(href, request.url).toString();
                const pageNo = listingPageNumber(nextUrl);
                if (pageNo > currentPage && !visitedListingUrls.has(nextUrl)) candidates.push({ pageNo, nextUrl });
            } catch {}
        });

        let nextHref = $('a').filter((_, el) => $(el).text().trim().toLowerCase() === 'напред').attr('href');
        if (nextHref) {
            try {
                const nextUrl = new URL(nextHref, request.url).toString();
                if (!visitedListingUrls.has(nextUrl)) await enqueueLinks({ urls: [nextUrl] });
                return;
            } catch {}
        }

        candidates.sort((a, b) => a.pageNo - b.pageNo);
        if (candidates[0]) await enqueueLinks({ urls: [candidates[0].nextUrl] });
    },
    failedRequestHandler({ request, log: reqLog }) {
        reqLog.warning(`Провалена страница от списъка: ${request.url}`);
    },
});

if (mode === 'scrape' || mode === 'both' || (mode === 'send' && (!dealerUrls || dealerUrls.length === 0))) {
    await listingCrawler.run([effectiveStartUrl]);
    log.info(`Намерени ${dealerLinks.size} уникални дилъра в ${listingPagesVisited} страници от списъка.`);
}

let dealerEntries;
if (dealerUrls && dealerUrls.length > 0) {
    dealerEntries = dealerUrls.map((u) => [u.replace(/\/+$/, ''), null]);
} else {
    dealerEntries = [...dealerLinks.entries()];
}
if (maxDealers > 0) dealerEntries = dealerEntries.slice(0, maxDealers);

const PHONE_REGEX = /(\+359[\s.-]?\d{1,3}[\s.-]?\d{3}[\s.-]?\d{3,4}|0\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4})/g;

function cleanPhone(raw) {
    return raw.replace(/[\s.-]/g, '');
}

function extractBetween(text, startMarker, endMarkers) {
    const startIdx = text.indexOf(startMarker);
    if (startIdx === -1) return null;
    const sliceStart = startIdx + startMarker.length;
    let sliceEnd = text.length;
    for (const marker of endMarkers) {
        const idx = text.indexOf(marker, sliceStart);
        if (idx !== -1 && idx < sliceEnd) sliceEnd = idx;
    }
    const value = text.slice(sliceStart, sliceEnd).trim();
    return value || null;
}

let dealerResults = [];

const contactsCrawler = new CheerioCrawler({
    maxConcurrency,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ request, $, log: reqLog }) {
        const { dealerUrl, listedName } = request.userData;
        const pageText = $.root().text().replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();

        let dealerName = $('h1').first().text().trim().replace(/^Контакти\s*-\s*/i, '').trim();
        if (!dealerName) dealerName = listedName || null;

        const phonesRaw = pageText.match(PHONE_REGEX) || [];
        const phones = [...new Set(phonesRaw.map(cleanPhone))];
        const address = extractBetween(pageText, 'Адрес:', ['Кореспондентски адрес:', 'Обяви', 'Изпратете', 'За да се свържете', 'Powered by']);
        const correspondenceAddress = extractBetween(pageText, 'Кореспондентски адрес:', ['Обяви', 'Изпратете', 'За да се свържете', 'Powered by']);
        const trimTo200 = (v) => (v && v.length > 200 ? `${v.slice(0, 200).trim()}…` : v);
        const memberSinceMatch = pageText.match(/в mobile\.bg\s+от\s+(\d{4})\s*г\./i);

        dealerResults.push({
            dealerName,
            dealerUrl,
            contactsUrl: request.url,
            phones,
            address: trimTo200(address),
            correspondenceAddress: trimTo200(correspondenceAddress),
            memberSince: memberSinceMatch ? memberSinceMatch[1] : null,
            officialWebsite: null,
            emails: [],
            scrapedAt: new Date().toISOString(),
        });

        if (phones.length === 0) reqLog.warning(`Не е намерен телефон за ${dealerUrl}.`);
    },
    failedRequestHandler({ request, log: reqLog }) {
        reqLog.warning(`Провалена страница с контакти: ${request.url}`);
    },
});

if (mode === 'scrape' || mode === 'both') {
    await contactsCrawler.run(dealerEntries.map(([dealerUrl, listedName]) => ({
        url: `${dealerUrl}/contacts`,
        userData: { dealerUrl, listedName },
    })));
    log.info(`Извлечени контакти за ${dealerResults.length} дилъра.`);
} else {
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

const BLACKLISTED_DOMAINS = [
    'mobile.bg', 'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'linkedin.com',
    'olx.bg', 'bazar.bg', 'imot.bg', 'auto.bg', 'cars.bg', 'google.com', 'g.page', 'goo.gl',
    'zlatnistranici.bg', 'wikipedia.org', 'apify.com',
];

function isBlacklisted(urlString) {
    try {
        const host = new URL(urlString).hostname.replace(/^www\./, '').toLowerCase();
        return BLACKLISTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
        return true;
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
        const queryToDealer = new Map();
        dealersWithName.forEach((d, i) => queryToDealer.set(queries[i], d));
        for (const item of searchItems) {
            const dealer = queryToDealer.get(item?.searchQuery?.term);
            if (!dealer) continue;
            const firstGood = (item.organicResults || []).find((r) => r?.url && !isBlacklisted(r.url));
            if (firstGood) dealer.officialWebsite = firstGood.url;
        }
        log.info(`Намерени официални уебсайтове за ${dealerResults.filter((d) => d.officialWebsite).length} от ${dealersWithName.length} дилъра.`);
    } catch (err) {
        log.warning(`Търсенето в Google се провали: ${err.message}. Продължавам без официални уебсайтове.`);
    }
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const GENERIC_JUNK_EMAILS = new Set(['example@example.com', 'name@example.com', 'you@example.com']);

async function fetchHtml(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DealerEmailBot/1.0)', Accept: 'text/html,application/xhtml+xml' },
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
    return [...new Set([...mailtoMatches, ...textMatches]
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e && !GENERIC_JUNK_EMAILS.has(e) && !e.endsWith('.png') && !e.endsWith('.jpg')))];
}

async function findContactPageUrl(baseUrl, html) {
    if (!html) return null;
    const hrefMatches = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
    const candidate = hrefMatches.find((h) => /kontakt|contact/i.test(h)) || hrefMatches.find((h) => /za-nas|about/i.test(h));
    if (!candidate) return null;
    try {
        return new URL(candidate, baseUrl).toString();
    } catch {
        return null;
    }
}

async function solveRecaptcha2(sitekey, pageUrl, apiKey, timeoutMs = 120000) {
    if (!apiKey) throw new Error('No 2captcha API key provided');
    const params = new URLSearchParams({ key: apiKey, method: 'userrecaptcha', googlekey: sitekey, pageurl: pageUrl, json: '1' });
    const inRes = await fetch(`https://2captcha.com/in.php?${params.toString()}`);
    const inJson = await inRes.json();
    if (!inJson || inJson.status !== 1) throw new Error(`2captcha in.php error: ${JSON.stringify(inJson)}`);
    const requestId = inJson.request;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5000));
        const res = await fetch(`https://2captcha.com/res.php?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(requestId)}&json=1`);
        const body = await res.json();
        if (body.status === 1 && body.request) return body.request;
        if (body.request && body.request.includes('ERROR')) throw new Error(`2captcha error: ${body.request}`);
    }
    throw new Error('2captcha timeout waiting for solution');
}

async function solveImageCaptcha2(imageBase64, apiKey, timeoutMs = 120000) {
    if (!apiKey) throw new Error('No 2captcha API key provided');
    const params = new URLSearchParams({ method: 'base64', key: apiKey, body: imageBase64, json: '1' });
    const inRes = await fetch('https://2captcha.com/in.php', { method: 'POST', body: params });
    const inJson = await inRes.json();
    if (!inJson || inJson.status !== 1) throw new Error(`2captcha in.php error: ${JSON.stringify(inJson)}`);
    const requestId = inJson.request;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 5000));
        const res = await fetch(`https://2captcha.com/res.php?key=${encodeURIComponent(apiKey)}&action=get&id=${encodeURIComponent(requestId)}&json=1`);
        const body = await res.json();
        if (body.status === 1 && body.request) return body.request;
        if (body.request && body.request.includes('ERROR')) throw new Error(`2captcha error: ${body.request}`);
    }
    throw new Error('2captcha timeout waiting for image solution');
}

async function solveImageCaptchaOCR(imageBase64) {
    const buffer = Buffer.from(imageBase64, 'base64');
    const img = sharp(buffer);
    const meta = await img.metadata();
    const width = meta.width || 200;
    const processed = await img.grayscale().resize(Math.min(1000, Math.max(200, Math.round(width * 3)))).normalise().threshold(145).toBuffer();
    const res = await Tesseract.recognize(processed, 'eng');
    return (res?.data?.text || '').replace(/[^A-Za-z0-9]/g, '').trim();
}

function normaliseText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const SUCCESS_PATTERNS = [
    /благодарим/, /успешно\s+(е\s+)?изпратен/, /запитването\s+(ви\s+)?(е\s+)?изпратено/,
    /съобщението\s+(ви\s+)?(е\s+)?изпратено/, /вашето\s+запитване\s+(беше\s+)?изпратено/,
    /заявката\s+(ви\s+)?е\s+получена/, /message\s+has\s+been\s+sent/i, /thank\s+you\s+for\s+your\s+(message|inquiry)/i,
];

const ERROR_PATTERNS = [
    /грешен\s+код/, /невалиден\s+код/, /кодът\s+не\s+съвпада/, /неправилен\s+код/,
    /невалидна\s+captcha/i, /invalid\s+captcha/i, /captcha.{0,20}(греш|невалид|failed)/i,
    /моля[, ]+въведете\s+кода/, /моля[, ]+попълнете/, /не сте попълнили/, /задължително поле/,
    /please\s+fill/, /please\s+try\s+again/i,
];

function matchesAny(text, patterns) {
    return patterns.some((re) => re.test(text));
}

async function locateContactForm(page) {
    const forms = await page.$$eval('form', (nodes) => nodes.map((form, index) => {
        const text = (form.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const controls = [...form.querySelectorAll('input, textarea, select, button')];
        const attrs = controls.map((el) => `${el.name || ''} ${el.id || ''} ${el.placeholder || ''} ${el.value || ''}`).join(' ').toLowerCase();
        let score = 0;
        if (/изпрати\s+запитване/.test(text)) score += 12;
        if (/вашето\s+име|вашия\s+телефон|вашия\s+е-?mail|запитване/.test(text)) score += 8;
        if (/captcha|въведете\s+кода|код/.test(`${text} ${attrs}`)) score += 6;
        if (form.querySelector('textarea')) score += 3;
        if (form.querySelector('input[type="submit"], button[type="submit"], button')) score += 2;
        return { index, score, text: text.slice(0, 250), action: form.action || '', method: (form.method || 'get').toLowerCase() };
    }));

    forms.sort((a, b) => b.score - a.score);
    const best = forms[0];
    if (!best || best.score < 8) return null;
    return best;
}

async function getFormFields(formLocator) {
    return await formLocator.locator('input, textarea, select').evaluateAll((els) => els.map((el, index) => {
        const id = el.id || '';
        let label = '';
        if (id) {
            const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (lab) label = lab.innerText || '';
        }
        if (!label) {
            let p = el.parentElement;
            for (let i = 0; i < 4 && p; i += 1, p = p.parentElement) {
                if (p.tagName?.toLowerCase() === 'label') { label = p.innerText || ''; break; }
            }
        }
        if (!label) {
            const prev = el.previousElementSibling;
            if (prev && /label|span|div|p/i.test(prev.tagName)) label = prev.innerText || '';
        }
        return {
            index,
            tag: el.tagName.toLowerCase(),
            type: (el.type || '').toLowerCase(),
            name: el.name || '',
            id,
            placeholder: el.placeholder || '',
            aria: el.getAttribute('aria-label') || '',
            className: typeof el.className === 'string' ? el.className : '',
            label,
            required: !!el.required,
            disabled: !!el.disabled,
            readOnly: !!el.readOnly,
            value: el.value || '',
        };
    }));
}

function classifyField(meta) {
    const hay = normaliseText(`${meta.name} ${meta.id} ${meta.placeholder} ${meta.aria} ${meta.label} ${meta.className}`);
    if (meta.type === 'hidden' || meta.type === 'checkbox' || meta.type === 'radio' || meta.type === 'submit' || meta.type === 'button' || meta.type === 'image' || meta.disabled || meta.readOnly) return null;
    if (/captcha|verification|verify|security|код/.test(hay)) return 'captcha';
    if (meta.tag === 'textarea' || /message|msg|comment|description|note|запитване|съобщение/.test(hay)) return 'message';
    if (/e-?mail|email|имейл|електронна\s+поща/.test(hay) || meta.type === 'email') return 'email';
    if (/phone|телефон|мобилен|gsm|fone|mobile/.test(hay) || meta.type === 'tel') return 'phone';
    if (/subject|title|тема|предмет/.test(hay)) return 'subject';
    if (/name|fullname|contact|име|фирма/.test(hay)) return 'name';
    return null;
}

async function fillContactFields(formLocator, formData, dealerHost) {
    const fields = await getFormFields(formLocator);
    const filled = {};
    const fillErrors = [];

    for (const meta of fields) {
        const key = classifyField(meta);
        if (!key || key === 'captcha') continue;
        const value = formData[key];
        if (value === undefined || value === null || String(value).trim() === '') continue;
        const control = formLocator.locator('input, textarea, select').nth(meta.index);
        try {
            if (meta.tag === 'select') await control.selectOption(String(value));
            else await control.fill(String(value));
            const after = await control.inputValue().catch(() => '');
            if (after !== String(value) && meta.tag !== 'select') throw new Error(`value-not-applied (actual="${after}")`);
            filled[key] = { index: meta.index, name: meta.name || meta.id || null };
        } catch (err) {
            fillErrors.push({ key, index: meta.index, name: meta.name || meta.id || null, error: err.message });
        }
    }

    const expected = ['name', 'phone', 'email', 'message'].filter((key) => String(formData[key] || '').trim());
    const missing = expected.filter((key) => !filled[key]);
    log.info(`[Форма] ${dealerHost}: попълнени полета=${Object.keys(filled).join(', ') || 'няма'}${missing.length ? ` | НЕнамерени=${missing.join(', ')}` : ''}`);
    return { fields, filled, missing, fillErrors };
}

async function checkAgreementBoxes(formLocator) {
    const boxes = formLocator.locator('input[type="checkbox"]');
    const count = await boxes.count();
    const results = [];
    for (let i = 0; i < count; i += 1) {
        const box = boxes.nth(i);
        if (!(await box.isEnabled().catch(() => false))) continue;
        try {
            if (!(await box.isChecked())) await box.check({ force: true });
            results.push({ index: i, checked: await box.isChecked() });
        } catch (err) {
            results.push({ index: i, checked: false, error: err.message });
        }
    }
    return results;
}

async function solveCaptchaInForm(page, formLocator, dealerHost, apiKey, timeoutMs) {
    const info = { present: false, type: 'none', solveMethod: 'none', solveAttempted: false, solveValue: null, passed: null };

    const sitekey = await formLocator.locator('[data-sitekey], .g-recaptcha').first().getAttribute('data-sitekey').catch(() => null);
    if (sitekey) {
        info.present = true;
        info.type = 'recaptcha';
        if (!apiKey) throw Object.assign(new Error('captcha-present-no-api-key'), { captchaInfo: info });
        info.solveMethod = '2captcha';
        info.solveAttempted = true;
        const token = await solveRecaptcha2(sitekey, page.url(), apiKey, Math.min(120000, timeoutMs));
        info.solveValue = token ? `${token.slice(0, 12)}…` : null;
        await page.evaluate((value) => {
            const candidates = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
            const textarea = candidates[candidates.length - 1];
            if (textarea) {
                textarea.value = value;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, token);
        log.info(`[Captcha] ${dealerHost}: reCAPTCHA решена през 2captcha.`);
        return { info, captchaToken: token };
    }

    const captchaImg = formLocator.locator('img[src*="captcha" i], img[class*="captcha" i], img[id*="captcha" i], img[alt*="captcha" i], img[title*="captcha" i]').first();
    if (await captchaImg.count()) {
        info.present = true;
        info.type = 'image';
        await captchaImg.scrollIntoViewIfNeeded().catch(() => null);
        const imageBuffer = await captchaImg.screenshot({ type: 'png' });
        const base64 = imageBuffer.toString('base64');
        let solved;
        if (apiKey) {
            info.solveMethod = '2captcha';
            info.solveAttempted = true;
            solved = await solveImageCaptcha2(base64, apiKey, Math.min(120000, timeoutMs));
        } else {
            info.solveMethod = 'ocr';
            info.solveAttempted = true;
            solved = await solveImageCaptchaOCR(base64);
        }
        solved = String(solved || '').trim();
        info.solveValue = solved || null;
        if (!solved || solved.length < 3 || solved.length > 12) {
            throw Object.assign(new Error(`invalid-captcha-solution:${solved || '(empty)'}`), { captchaInfo: info });
        }

        if (debugSaveCaptcha) {
            try {
                await fs.mkdir('captchas', { recursive: true });
                const stamp = Date.now();
                const path = `captchas/${dealerHost.replace(/[^a-z0-9.-]/gi, '_')}-${stamp}.png`;
                await fs.writeFile(path, imageBuffer);
                await fs.writeFile(`${path}.txt`, solved, 'utf8');
            } catch {}
        }

        const fields = await getFormFields(formLocator);
        let captchaMeta = fields.find((meta) => classifyField(meta) === 'captcha');
        if (!captchaMeta) {
            captchaMeta = fields.find((meta) => {
                if (meta.type === 'hidden' || meta.type === 'checkbox' || meta.type === 'submit' || meta.disabled) return false;
                const hay = normaliseText(`${meta.name} ${meta.id} ${meta.placeholder} ${meta.label}`);
                return /код|code|verify|security/.test(hay);
            });
        }
        if (!captchaMeta) throw Object.assign(new Error('captcha-input-not-found'), { captchaInfo: info });

        const captchaInput = formLocator.locator('input, textarea, select').nth(captchaMeta.index);
        await captchaInput.fill(solved);
        const actual = await captchaInput.inputValue().catch(() => '');
        if (actual !== solved) throw Object.assign(new Error(`captcha-value-not-applied:${actual}`), { captchaInfo: info });
        log.info(`[Captcha] ${dealerHost}: картинна captcha решена чрез ${info.solveMethod} -> "${solved}" и е попълнена в полето.`);
        return { info, captchaToken: null };
    }

    return { info, captchaToken: null };
}

async function validateForm(formLocator) {
    return await formLocator.evaluate((form) => {
        const invalid = [...form.elements]
            .filter((el) => typeof el.checkValidity === 'function' && !el.checkValidity())
            .map((el) => ({
                tag: el.tagName?.toLowerCase() || '',
                type: el.type || '',
                name: el.name || '',
                id: el.id || '',
                value: el.type === 'password' ? '(hidden)' : (el.value || ''),
                message: el.validationMessage || '',
                required: !!el.required,
                checked: typeof el.checked === 'boolean' ? el.checked : undefined,
            }));
        return { valid: form.checkValidity(), invalid };
    });
}

async function findSubmitControl(formLocator) {
    const direct = formLocator.locator('button[type="submit"], input[type="submit"]').first();
    if (await direct.count()) return direct;

    const buttons = formLocator.locator('button, input[type="button"], a');
    const count = await buttons.count();
    for (let i = 0; i < count; i += 1) {
        const item = buttons.nth(i);
        const text = normaliseText(`${await item.innerText().catch(() => '')} ${await item.getAttribute('value').catch(() => '')}`);
        if (/изпрати\s+запитването|изпрати\s+запитване|изпрати|send/.test(text)) return item;
    }
    return null;
}

async function inspectSubmitState(page, originalUrl, formInfo, postResponses) {
    const bodyText = normaliseText(await page.locator('body').innerText().catch(() => ''));
    const success = matchesAny(bodyText, SUCCESS_PATTERNS) || /thank-you|thanks-for|success/.test(page.url().toLowerCase());
    const error = matchesAny(bodyText, ERROR_PATTERNS);
    const currentUrl = page.url();

    let contactFormStillPresent = false;
    const located = await locateContactForm(page).catch(() => null);
    if (located && located.score >= 8) contactFormStillPresent = true;

    const successfulHttpPosts = postResponses.filter((r) => r.status >= 200 && r.status < 400);
    const failedHttpPosts = postResponses.filter((r) => r.status >= 400);
    const urlChanged = currentUrl !== originalUrl;
    const networkSubmitted = postResponses.length > 0;

    let status = 'unknown-clicked';
    let reason = 'no-clear-confirmation-on-page';
    if (success && !error) {
        status = 'sent';
        reason = 'explicit-success-confirmation';
    } else if (error || failedHttpPosts.length > 0) {
        status = 'failed';
        reason = error ? 'site-validation-or-captcha-error' : `http-error-${failedHttpPosts[0]?.status}`;
    } else if (successfulHttpPosts.length > 0 && !contactFormStillPresent && (urlChanged || successfulHttpPosts.some((r) => r.url !== originalUrl))) {
        status = 'sent';
        reason = 'successful-post-and-form-disappeared';
    } else if (!networkSubmitted) {
        status = 'failed';
        reason = 'no-post-request-detected';
    }

    return {
        status,
        reason,
        bodySnippet: bodyText.slice(0, 700),
        currentUrl,
        urlChanged,
        contactFormStillPresent,
        postResponses,
        formInfo,
    };
}

async function submitContactFormWithPlaywright(url, formData = {}, captchaApiKeyLocal = null, timeoutMs = 60000) {
    const dealerHost = new URL(url).hostname;
    let browser;
    let context;
    let page;
    let captchaInfo = { present: false, type: 'none', solveMethod: 'none', solveAttempted: false, solveValue: null, passed: null };
    let captchaToken = null;

    try {
        browser = await playwright.chromium.launch({
            headless: true,
            args: ['--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions', '--disable-background-networking'],
        });
        context = await browser.newContext({
            locale: 'bg-BG',
            viewport: { width: 1365, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        });
        page = await context.newPage();
        page.setDefaultTimeout(Math.min(30000, timeoutMs));
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(30000, timeoutMs) });

        const formInfo = await locateContactForm(page);
        if (!formInfo) {
            return { status: 'failed', submitted: false, success: false, error: true, reason: 'contact-form-not-found', captcha: captchaInfo, finalUrl: page.url() };
        }
        log.info(`[Форма] ${dealerHost}: намерена контактна форма #${formInfo.index + 1}, method=${formInfo.method}, action=${formInfo.action || '(same page)'}, score=${formInfo.score}.`);

        const formLocator = page.locator('form').nth(formInfo.index);
        const fillState = await fillContactFields(formLocator, formData, dealerHost);
        if (fillState.fillErrors.length) log.warning(`[Форма] ${dealerHost}: грешки при попълване: ${JSON.stringify(fillState.fillErrors)}`);
        if (fillState.missing.length) {
            return {
                status: 'failed', submitted: false, success: false, error: true,
                reason: `expected-fields-not-found:${fillState.missing.join(',')}`,
                missingFields: fillState.missing,
                fillErrors: fillState.fillErrors,
                captcha: captchaInfo,
                finalUrl: page.url(),
            };
        }

        const checkboxState = await checkAgreementBoxes(formLocator);
        const unchecked = checkboxState.filter((x) => !x.checked);
        if (unchecked.length) {
            return { status: 'failed', submitted: false, success: false, error: true, reason: 'agreement-checkbox-not-checked', checkboxState, captcha: captchaInfo, finalUrl: page.url() };
        }

        try {
            const captchaResult = await solveCaptchaInForm(page, formLocator, dealerHost, captchaApiKeyLocal, timeoutMs);
            captchaInfo = captchaResult.info;
            captchaToken = captchaResult.captchaToken;
        } catch (err) {
            if (err.captchaInfo) captchaInfo = err.captchaInfo;
            log.warning(`[Captcha] ${dealerHost}: ${err.message}`);
            return { status: 'failed', submitted: false, success: false, error: true, reason: err.message, captcha: captchaInfo, finalUrl: page.url() };
        }

        const validation = await validateForm(formLocator);
        if (!validation.valid) {
            log.warning(`[Форма] ${dealerHost}: HTML validation блокира submit: ${JSON.stringify(validation.invalid)}`);
            return {
                status: 'failed', submitted: false, success: false, error: true,
                reason: 'form-validation-failed', invalidFields: validation.invalid,
                captcha: captchaInfo, finalUrl: page.url(),
            };
        }

        const postResponses = [];
        const onResponse = (response) => {
            try {
                const request = response.request();
                if (request.method().toUpperCase() === 'POST') {
                    postResponses.push({ url: response.url(), status: response.status(), method: 'POST', resourceType: request.resourceType() });
                }
            } catch {}
        };
        page.on('response', onResponse);

        const originalUrl = page.url();
        const submitControl = await findSubmitControl(formLocator);
        let clicked = false;
        if (submitControl) {
            await submitControl.scrollIntoViewIfNeeded().catch(() => null);
            await submitControl.click({ timeout: Math.min(15000, timeoutMs) });
            clicked = true;
        } else {
            clicked = await formLocator.evaluate((form) => {
                try {
                    if (typeof form.requestSubmit === 'function') form.requestSubmit();
                    else form.submit();
                    return true;
                } catch {
                    return false;
                }
            });
        }

        if (!clicked) {
            page.off('response', onResponse);
            return { status: 'failed', submitted: false, success: false, error: true, reason: 'submit-action-failed', captcha: captchaInfo, finalUrl: page.url() };
        }

        await Promise.race([
            page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
            page.waitForTimeout(2500),
        ]);
        await page.waitForTimeout(1500);
        page.off('response', onResponse);

        const submitState = await inspectSubmitState(page, originalUrl, formInfo, postResponses);
        const status = submitState.status;
        const success = status === 'sent';
        const error = status === 'failed';

        if (captchaInfo.present) {
            const captchaError = /captcha|грешен\s+код|невалиден\s+код|неправилен\s+код|въведете\s+кода/i.test(submitState.bodySnippet);
            captchaInfo.passed = success ? true : (captchaError ? false : null);
        }

        const statusLabel = status === 'sent' ? 'ИЗПРАТЕНО' : status === 'failed' ? 'НЕУСПЕШНО' : 'НЕЯСНО';
        log.info(`[Форма] ${dealerHost}: резултат=${statusLabel}, reason=${submitState.reason}, POST=${postResponses.length ? JSON.stringify(postResponses) : 'НЯМА'} | текст="${submitState.bodySnippet.slice(0, 250)}${submitState.bodySnippet.length > 250 ? '…' : ''}"`);
        if (captchaInfo.present) {
            const captchaLabel = captchaInfo.passed === true ? 'МИНА успешно' : captchaInfo.passed === false ? 'НЕ мина' : 'неясно';
            log.info(`[Captcha] ${dealerHost}: тип=${captchaInfo.type}, метод=${captchaInfo.solveMethod}, резултат=${captchaLabel}`);
        }

        return {
            status,
            submitted: postResponses.length > 0,
            clicked: true,
            success,
            error,
            reason: submitState.reason,
            captchaToken,
            captcha: captchaInfo,
            finalUrl: submitState.currentUrl,
            confirmationSnippet: submitState.bodySnippet,
            postResponses,
            formStillVisible: submitState.contactFormStillPresent,
        };
    } catch (err) {
        log.warning(`[Форма] ${dealerHost}: неочаквана грешка: ${err.message}`);
        return { status: 'failed', submitted: false, success: false, error: true, reason: err.message, captcha: captchaInfo, finalUrl: page?.url?.() || url };
    } finally {
        await context?.close().catch(() => null);
        await browser?.close().catch(() => null);
    }
}

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
            if (contactUrl) emails = extractEmailsFromHtml(await fetchHtml(contactUrl));
        }
        dealer.emails = emails;
    });
    log.info(`Намерени имейли за ${dealerResults.filter((d) => d.emails.length > 0).length} дилъра.`);
}

if (submitContactForm && dealerResults.length > 0 && (mode === 'send' || mode === 'both')) {
    let targets = dealerResults;
    if (skipAlreadyContacted && contactedUrls.size > 0) {
        const alreadyContacted = dealerResults.filter((d) => contactedUrls.has(d.dealerUrl));
        alreadyContacted.forEach((d) => { d.contactForm = { status: 'skipped', submitted: false, reason: 'already-contacted-previous-run' }; });
        targets = dealerResults.filter((d) => !contactedUrls.has(d.dealerUrl));
        if (alreadyContacted.length > 0) log.info(`Прескочени ${alreadyContacted.length} вече контактувани дилъра.`);
    }

    log.info(`ФАЗА: Попълване на контактни форми за ${targets.length} дилъра (максимум ${maxBrowserConcurrency} браузъра едновременно)…`);
    await runWithConcurrency(targets, Math.max(1, maxBrowserConcurrency), async (dealer) => {
        try {
            const res = await submitContactFormWithPlaywright(dealer.contactsUrl, contactFormData, captchaApiKey, formSubmitTimeoutMs);
            dealer.contactForm = res;
            if (res?.status === 'sent') contactedUrls.add(dealer.dealerUrl);
        } catch (err) {
            log.error(`[Contact form] Неочаквана грешка за ${dealer.dealerUrl}: ${err.message}`);
            dealer.contactForm = { status: 'failed', submitted: false, success: false, reason: err.message };
        }
    });

    const sentCount = targets.filter((d) => d.contactForm?.status === 'sent').length;
    const unknownCount = targets.filter((d) => d.contactForm?.status === 'unknown-clicked').length;
    const failedCount = targets.filter((d) => d.contactForm?.status === 'failed').length;
    log.info(`Резултат от изпращането: ${sentCount} изпратени, ${unknownCount} подадени без ясно потвърждение, ${failedCount} неуспешни.`);

    const withCaptcha = targets.filter((d) => d.contactForm?.captcha?.present);
    if (withCaptcha.length > 0) {
        const captchaPassed = withCaptcha.filter((d) => d.contactForm.captcha.passed === true).length;
        const captchaFailed = withCaptcha.filter((d) => d.contactForm.captcha.passed === false).length;
        const captchaUnknown = withCaptcha.filter((d) => d.contactForm.captcha.passed === null).length;
        log.info(`Капчи: ${withCaptcha.length} -> ${captchaPassed} успешни, ${captchaFailed} неуспешни, ${captchaUnknown} неясни.`);
    }

    await contactedStore.setValue('contactedUrls', [...contactedUrls]);
}

await Actor.pushData(dealerResults);
log.info('Готово.');
await Actor.exit();
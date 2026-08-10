import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import { CheerioCrawler, log } from 'crawlee';
import playwright from 'playwright';
import Tesseract from 'tesseract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runLocal(input, outputPath = null) {
    const {
        startUrl = 'https://www.mobile.bg/dealers',
        maxListingPages = 0,
        maxDealers = 0,
        maxConcurrency = 10,
        findOfficialWebsite = false,
        scrapeEmails = false,
        googleSearchCountryCode = 'bg',
        googleSearchLanguageCode = 'bg',
        submitContactForm = false,
        contactFormData = {},
        captchaApiKey = null,
        formSubmitTimeoutMs = 60000,
        mode = 'scrape',
        dealerUrls = [],
        debugSaveCaptcha = false,
    } = input;

// The rest of the logic mirrors src/main.js but simplified for local usage.
// (We only reuse the scraping logic, skipping any Actor-specific calls.)

const PHONE_REGEX = /(\+359[\s.-]?\d{1,3}[\s.-]?\d{3}[\s.-]?\d{3,4}|0\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4})/g;
function cleanPhone(raw) { return raw.replace(/[\s.-]/g, ''); }
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
    } catch { return null; } finally { clearTimeout(timer); }
}

async function solveRecaptcha2(sitekey, pageUrl, apiKey, timeoutMs = 120000) {
    if (!apiKey) throw new Error('No 2captcha API key provided');
    const params = new URLSearchParams({ key: apiKey, method: 'userrecaptcha', googlekey: sitekey, pageurl: pageUrl, json: '1' });
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
    const params = new URLSearchParams({ method: 'base64', key: apiKey, body: imageBase64, json: '1' });
    const inRes = await fetch('http://2captcha.com/in.php', { method: 'POST', body: params });
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

async function solveImageCaptchaOCR(imageBase64) {
    try {
        const buffer = Buffer.from(imageBase64, 'base64');
        const res = await Tesseract.recognize(buffer, 'eng');
        const text = (res && res.data && res.data.text) ? res.data.text : '';
        const cleaned = text.replace(/[^A-Za-z0-9]/g, '').trim();
        return cleaned;
    } catch (err) {
        throw new Error(`ocr-failed: ${err.message}`);
    }
}

async function detectSubmitResult(page) {
    const content = (await page.content()).replace(/\s+/g, ' ').trim().toLowerCase();
    const successPatterns = [
        /изпратен[оa]?/, /успешн[оa]?/, /благодарим/, /thank you/, /your message/, /съобщението е изпратено/, /заявката е получена/, /вече е изпратено/,
        /вашето (запитване|съобщение) (е )?изпратен[оa]?/, /съобщението беше изпратено/, /успешно изпратено/, /благодарим ви/, /thank you for/, /message has been sent/
    ];
    const errorPatterns = [
        /грешк[аие]*/i, /не( е)? изпратено/, /неуспешн[оa]?/, /captcha/i, /грешен/, /невалидн[аои]?/, /моля/, /попълн[ете]?/, /код за потвърждение/, /please fill/, /invalid/, /failed/, /error/
    ];
    const url = page.url().toLowerCase();
    const formStillVisible = await page.$('form').then(Boolean).catch(() => false);
    const hasSuccess = successPatterns.some((re) => re.test(content)) || /thank-you|thanks|success|successful/.test(url);
    const hasError = errorPatterns.some((re) => re.test(content)) || /error|failed|неуспешн[оa]?/.test(url);
    return {
        pageTextSnippet: content.slice(0, 500),
        isSuccess: hasSuccess,
        isError: hasError,
        formStillVisible,
    };
}

function isBlacklisted(urlString) {
    try { const host = new URL(urlString).hostname.replace(/^www\./, '').toLowerCase(); const BLACKLISTED_DOMAINS = ['mobile.bg','facebook.com','instagram.com','tiktok.com','youtube.com','linkedin.com','olx.bg','bazar.bg','imot.bg','auto.bg','cars.bg','google.com','g.page','goo.gl','zlatnistranici.bg','wikipedia.org','apify.com']; return BLACKLISTED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)); } catch { return true; }
}

const dealerLinks = new Map();
let listingPagesVisited = 0;

const listingCrawler = new CheerioCrawler({
    maxConcurrency: 3,
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ request, $, enqueueLinks, log: reqLog }) {
        listingPagesVisited += 1;
        reqLog.info(`[Списък] ${request.url} (страница ${listingPagesVisited})`);
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href'); if (!href) return;
            const m = href.match(/^https?:\/\/([a-z0-9-]+)\.mobile\.bg\/?(?:[?#].*)?$/i);
            if (!m) return;
            const subdomain = m[1].toLowerCase(); if (subdomain === 'www') return;
            const dealerUrl = `https://${subdomain}.mobile.bg`;
            const text = $(el).text().trim();
            if (!dealerLinks.has(dealerUrl)) dealerLinks.set(dealerUrl, text || null);
            else if (text && !dealerLinks.get(dealerUrl)) dealerLinks.set(dealerUrl, text);
        });
        if (maxListingPages > 0 && listingPagesVisited >= maxListingPages) return;
        let nextHref = $('a').filter((_, el) => $(el).text().trim().toLowerCase() === 'напред').attr('href');
        if (!nextHref) nextHref = $('a[href*="/dealers/p-"]').attr('href');
        if (nextHref) { const nextUrl = new URL(nextHref, request.url).toString(); await enqueueLinks({ urls: [nextUrl] }); }
    },
    failedRequestHandler({ request, log: reqLog }) { reqLog.warning(`Провалена страница от списъка: ${request.url}`); },
});

if (mode === 'scrape' || mode === 'both' || (mode === 'send' && (!dealerUrls || dealerUrls.length === 0))) {
    await listingCrawler.run([startUrl]);
    log.info(`Намерени ${dealerLinks.size} уникални дилъра в ${listingPagesVisited} страници от списъка.`);
}

let dealerEntries = [];
if (dealerUrls && dealerUrls.length > 0) dealerEntries = dealerUrls.map((u) => [u.replace(/\/+$/, ''), null]);
else dealerEntries = [...dealerLinks.entries()];
if (maxDealers > 0) dealerEntries = dealerEntries.slice(0, maxDealers);

const dealerResults = [];

const contactsCrawler = new CheerioCrawler({
    maxConcurrency,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 60,
    async requestHandler({ request, $, log: reqLog }) {
        const { dealerUrl, listedName } = request.userData;
        const pageText = $.root().text().replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();
        let dealerName = $('h1').first().text().trim(); dealerName = dealerName.replace(/^Контакти\s*-\s*/i, '').trim(); if (!dealerName) dealerName = listedName || null;
        const phonesRaw = pageText.match(PHONE_REGEX) || []; const phones = [...new Set(phonesRaw.map(cleanPhone))];
        const address = extractBetween(pageText, 'Адрес:', ['Кореспондентски адрес:', 'Обяви', 'Изпратете', 'За да се свържете', 'Powered by']);
        const correspondenceAddress = extractBetween(pageText, 'Кореспондентски адрес:', ['Обяви', 'Изпратете', 'За да се свържете', 'Powered by']);
        const trimTo200 = (v) => (v && v.length > 200 ? `${v.slice(0, 200).trim()}…` : v);
        const memberSinceMatch = pageText.match(/в mobile\.bg\s+от\s+(\d{4})\s*г\./i);
        const memberSince = memberSinceMatch ? memberSinceMatch[1] : null;
        const result = { dealerName, dealerUrl, contactsUrl: request.url, phones, address: trimTo200(address), correspondenceAddress: trimTo200(correspondenceAddress), memberSince, officialWebsite: null, emails: [], scrapedAt: new Date().toISOString() };
        if (phones.length === 0) reqLog.warning(`Не е намерен телефон за ${dealerUrl} — записвам все пак с празен масив.`);
        dealerResults.push(result);
    },
    failedRequestHandler({ request, log: reqLog }) { reqLog.warning(`Провалена страница с контакти: ${request.url}`); },
});

if (mode === 'scrape' || mode === 'both') {
    await contactsCrawler.run(dealerEntries.map(([dealerUrl, listedName]) => ({ url: `${dealerUrl}/contacts`, userData: { dealerUrl, listedName } })));
    log.info(`Извлечени контакти за ${dealerResults.length} дилъра.`);
} else {
    dealerEntries.forEach(([dealerUrl, listedName]) => dealerResults.push({ dealerName: listedName || null, dealerUrl, contactsUrl: `${dealerUrl.replace(/\/+$/, '')}/contacts`, phones: [], address: null, correspondenceAddress: null, memberSince: null, officialWebsite: null, emails: [], scrapedAt: new Date().toISOString() }));
    log.info(`Подготвени ${dealerResults.length} дилъра за подадени съобщения (режим send).`);
}

async function submitContactFormWithPlaywright(url, formData = {}, captchaApiKeyLocal = null, timeoutMs = 60000) {
    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const formHandle = await page.$('form');
        if (!formHandle) { await browser.close(); return { submitted: false, reason: 'no-form-found' }; }
        const fields = await page.$$eval('form:first-of-type input, form:first-of-type textarea, form:first-of-type select', (els) => els.map((el) => {
            const name = el.getAttribute('name');
            const id = el.id || null;
            const placeholder = el.getAttribute('placeholder') || '';
            const aria = el.getAttribute('aria-label') || '';
            const className = el.className || '';
            let label = '';
            if (id) {
                const labelEl = document.querySelector(`label[for="${id}"]`);
                if (labelEl) label = labelEl.innerText || '';
            }
            if (!label) {
                let parent = el.parentElement;
                for (let i = 0; i < 3 && parent; i += 1) {
                    if (parent.tagName.toLowerCase() === 'label') {
                        label = parent.innerText || '';
                        break;
                    }
                    parent = parent.parentElement;
                }
            }
            return {
                tag: el.tagName.toLowerCase(),
                type: el.type || null,
                name,
                id,
                placeholder,
                aria,
                label,
                className,
            };
        }));
        function matchKey(meta) {
            if (!meta) return null;
            const v = `${meta.name || ''} ${meta.id || ''} ${meta.placeholder || ''} ${meta.aria || ''} ${meta.label || ''} ${meta.className || ''}`.toLowerCase();
            if (/phone|телефон|мобилен|gsm|fone|mobile/i.test(v)) return 'phone';
            if (/name|fullname|contact|име|фирма/i.test(v)) return 'name';
            if (/email|e-?mail|имейл|електронна|поща/i.test(v)) return 'email';
            if (/subject|title|тема|предмет/i.test(v)) return 'subject';
            if (/message|msg|comment|description|note|запитване|съобщение|съобщението/i.test(v)) return 'message';
            return null;
        }
        await page.$$eval('form:first-of-type input[type=checkbox]', (els) => { els.forEach((checkbox) => { if (!checkbox.checked) checkbox.click(); }); }).catch(() => null);
        for (const meta of fields) {
            const key = matchKey(meta);
            if (!key) continue;
            const value = formData[key];
            if (!value) continue;
            const selectorParts = [];
            if (meta.name) selectorParts.push(`input[name="${meta.name}"]`, `textarea[name="${meta.name}"]`, `select[name="${meta.name}"]`);
            if (meta.id) selectorParts.push(`#${meta.id}`);
            if (meta.placeholder) selectorParts.push(`input[placeholder="${meta.placeholder}"]`, `textarea[placeholder="${meta.placeholder}"]`);
            const selector = selectorParts.join(', ');
            try {
                if (meta.tag === 'select') {
                    await page.selectOption(selector, value.toString());
                } else {
                    await page.fill(selector, value.toString());
                }
            } catch {}
        }
        const sitekey = await page.$eval('[data-sitekey], .g-recaptcha', (el) => el.getAttribute('data-sitekey')).catch(() => null);
        let captchaToken = null;
        if (sitekey) { if (!captchaApiKeyLocal) { await browser.close(); return { submitted: false, reason: 'captcha-present-no-api-key' }; } try { captchaToken = await solveRecaptcha2(sitekey, page.url(), captchaApiKeyLocal, Math.min(120000, timeoutMs)); await page.evaluate((token) => { let textarea = document.querySelector('textarea[name="g-recaptcha-response"]'); if (!textarea) { textarea = document.createElement('textarea'); textarea.name = 'g-recaptcha-response'; textarea.style.display = 'none'; document.body.appendChild(textarea); } textarea.value = token; }, captchaToken); } catch (err) { await browser.close(); return { submitted: false, reason: `captcha-solve-failed: ${err.message}` }; } }
        const imgHandle = await page.$('img[src*="captcha"], img[class*="captcha"], img[id*="captcha"], img[alt*="captcha"], img[title*="captcha"]');
        if (imgHandle) {
            try {
                const src = await imgHandle.getAttribute('src');
                const absolute = new URL(src, page.url()).toString();
                const ab = await fetch(absolute).then((r) => r.arrayBuffer());
                const base64 = Buffer.from(ab).toString('base64');
                let solved = null;
                if (captchaApiKeyLocal) {
                    solved = await solveImageCaptcha2(base64, captchaApiKeyLocal, Math.min(120000, timeoutMs));
                } else {
                    try { solved = await solveImageCaptchaOCR(base64); } catch (ocrErr) { await browser.close(); return { submitted: false, reason: `image-captcha-ocr-failed: ${ocrErr.message}` }; }
                    if (!solved) { await browser.close(); return { submitted: false, reason: 'image-captcha-present-no-api-key-or-ocr-empty' }; }
                }
                    // Optionally save captcha image and solution for debugging
                    if (debugSaveCaptcha) {
                        try {
                            await fs.mkdir('captchas', { recursive: true });
                            const host = new URL(page.url()).hostname.replace(/[^a-z0-9.-]/gi, '_');
                            const stamp = Date.now();
                            const imgPath = `captchas/${host}-${stamp}.png`;
                            await fs.writeFile(imgPath, Buffer.from(base64, 'base64'));
                            await fs.writeFile(`${imgPath}.txt`, solved.toString(), 'utf8');
                        } catch (e) {
                            // ignore save errors
                        }
                    }
                const inputSelector = await page.$eval('input[name*="code"], input[name*="captcha"], input[placeholder*="код"], input[id*="code"], input[id*="captcha"]', (el) => el.getAttribute('name') || el.id || null).catch(() => null);
                if (inputSelector) { const sel = inputSelector.includes(' ') || inputSelector.includes('#') ? `[name="${inputSelector}"]` : `input[name="${inputSelector}"]`; try { await page.fill(sel, solved.toString()); } catch {} }
                else { await page.evaluate((val) => { const img = document.querySelector('img[src*="captcha"], img[class*="captcha"], img[id*="captcha"], img[alt*="captcha"], img[title*="captcha"]'); if (!img) return; const input = img.parentElement.querySelector('input') || document.querySelector('input'); if (input) input.value = val; }, solved.toString()); }
            } catch (err) { await browser.close(); return { submitted: false, reason: `image-captcha-solve-failed: ${err.message}` }; }
        }
        let clicked = await page.$eval('form:first-of-type button[type="submit"], form:first-of-type input[type="submit"]', (el) => { el.click(); return true; }).catch(() => false);
        if (!clicked) {
            clicked = await page.$eval('form:first-of-type .addButton, form:first-of-type [onclick*="submit"], form:first-of-type [type="button"]', (el) => { el.click(); return true; }).catch(() => false);
        }
        if (!clicked) {
            clicked = await page.$eval('form:first-of-type', (f) => {
                try { f.submit(); return true; } catch { return false; }
            }).catch(() => false);
        }

        try {
            await Promise.race([
                page.waitForNavigation({ timeout: 5000 }).catch(() => null),
                new Promise((r) => setTimeout(r, 3000)),
            ]);
        } catch {}

        const submitResult = await detectSubmitResult(page);
        const finalUrl = page.url();
        await browser.close();

        const success = submitResult.isSuccess && !submitResult.isError;
        const error = submitResult.isError && !submitResult.isSuccess;

        return {
            submitted: !!clicked,
            clicked: !!clicked,
            captchaToken: captchaToken || null,
            finalUrl,
            success,
            error,
            confirmationSnippet: submitResult.pageTextSnippet,
            reason: !clicked ? 'submit-action-failed' : (!success && !error ? 'unknown-response' : undefined),
        };
    } catch (err) {
        await browser.close();
        return { submitted: false, reason: err.message };
    }
}

async function run() {
    if (submitContactForm && dealerResults.length > 0 && (mode === 'send' || mode === 'both')) {
        log.info(`ФАЗА: Попълване на контактни форми за ${dealerResults.length} дилъра…`);
        await (async function() {
            const queue = [...dealerResults];
            const limit = Math.max(1, Math.floor(maxConcurrency / 2));
            const runners = Array.from({ length: limit }, async () => {
                while (queue.length > 0) {
                    const dealer = queue.shift();
                    try { const res = await submitContactFormWithPlaywright(dealer.contactsUrl, contactFormData, captchaApiKey, formSubmitTimeoutMs); dealer.contactForm = res; }
                    catch (err) { dealer.contactForm = { submitted: false, reason: err.message }; }
                }
            });
            await Promise.all(runners);
        })();
        const submittedCount = dealerResults.filter((d) => d.contactForm && d.contactForm.submitted).length;
        log.info(`Успешно подадени форми за ${submittedCount} дилъра.`);
    }
    await fs.writeFile(outputPath, JSON.stringify(dealerResults, null, 2));
    log.info(`Записах резултата в ${outputPath}`);
    return dealerResults;
}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const inputPath = process.argv[2] || 'local_input.json';
    const outputPath = process.argv[3] || 'local_output.json';
    const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    await runLocal(input, outputPath);
}

// v10 diagnostic layer for Mobile.bg contact form POST responses.
// No OCR and no alternate CAPTCHA solver: paid 2Captcha flow remains unchanged.
// This layer inspects the returned HTML in a privacy-safe way to reveal hidden
// validation/error signals that are not present in form.innerText().

import playwright from 'playwright';

const nativeLaunch = playwright.chromium.launch.bind(playwright.chromium);

function compact(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripTags(value) {
    return compact(String(value || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'"));
}

function extractInterestingElements(html) {
    const out = [];
    const seen = new Set();
    const tagRe = /<(div|span|p|label|small|li|strong|b)[^>]*(?:class|id)=["'][^"']*(?:error|err|alert|warn|invalid|valid|success|message|msg|notice|captcha|code)[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;
    for (const match of String(html || '').matchAll(tagRe)) {
        const text = stripTags(match[2]);
        if (!text || text.length > 500 || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
        if (out.length >= 12) break;
    }
    return out;
}

function extractKeywordSnippets(html) {
    const plain = stripTags(html);
    const lower = plain.toLowerCase();
    const words = ['captcha', 'капча', 'код', 'греш', 'невалид', 'невер', 'правил', 'успеш', 'изпрат', 'благодар'];
    const snippets = [];
    const seen = new Set();
    for (const word of words) {
        let from = 0;
        while (snippets.length < 12) {
            const idx = lower.indexOf(word, from);
            if (idx < 0) break;
            const start = Math.max(0, idx - 100);
            const end = Math.min(plain.length, idx + 220);
            const snippet = compact(plain.slice(start, end));
            if (snippet && !seen.has(snippet)) {
                seen.add(snippet);
                snippets.push(snippet);
            }
            from = idx + word.length;
        }
    }
    return snippets;
}

function extractSafeFormState(html) {
    const result = [];
    const inputRe = /<input\b[^>]*>/gi;
    for (const match of String(html || '').matchAll(inputRe)) {
        const tag = match[0];
        const name = tag.match(/\bname=["']([^"']*)["']/i)?.[1] || '';
        if (!/^(act|s4|s5|s6|accept2)$/i.test(name)) continue;
        const type = tag.match(/\btype=["']([^"']*)["']/i)?.[1] || '';
        const value = tag.match(/\bvalue=["']([^"']*)["']/i)?.[1] || '';
        const checked = /\bchecked(?:\s|=|>|\/)/i.test(tag);
        result.push({
            name,
            type,
            valueLength: String(value).length,
            value: /^(act|accept2)$/i.test(name) ? value : undefined,
            checked,
        });
    }
    return result;
}

function extractCaptchaSrc(html) {
    const imgTags = String(html || '').match(/<img\b[^>]*>/gi) || [];
    const tag = imgTags.find((x) => /captcha/i.test(x));
    if (!tag) return null;
    return tag.match(/\bsrc=["']([^"']+)["']/i)?.[1] || null;
}

playwright.chromium.launch = async (...launchArgs) => {
    const browser = await nativeLaunch(...launchArgs);
    const nativeNewContext = browser.newContext.bind(browser);

    browser.newContext = async (...contextArgs) => {
        const context = await nativeNewContext(...contextArgs);
        const nativeNewPage = context.newPage.bind(context);

        context.newPage = async (...pageArgs) => {
            const page = await nativeNewPage(...pageArgs);
            page.__bgDealerPrePostCaptchaSrc = null;

            page.on('request', async (request) => {
                try {
                    if (request.method().toUpperCase() !== 'POST' || request.resourceType() !== 'document') return;
                    const src = await page.locator('form img[src*="captcha" i], form img[class*="captcha" i], form img[id*="captcha" i], form img[alt*="captcha" i]').first().getAttribute('src').catch(() => null);
                    page.__bgDealerPrePostCaptchaSrc = src || null;
                } catch {}
            });

            page.on('response', async (response) => {
                try {
                    const request = response.request();
                    if (request.method().toUpperCase() !== 'POST' || request.resourceType() !== 'document') return;
                    const contentType = String(response.headers()['content-type'] || '').toLowerCase();
                    if (!contentType.includes('text/html')) return;

                    const html = await response.text();
                    const host = new URL(response.url()).hostname;
                    const interesting = extractInterestingElements(html);
                    const snippets = extractKeywordSnippets(html);
                    const safeFormState = extractSafeFormState(html);
                    const afterCaptchaSrc = extractCaptchaSrc(html);
                    const beforeCaptchaSrc = page.__bgDealerPrePostCaptchaSrc;

                    console.log(`INFO  [POST response diagnostic] ${host}: status=${response.status()}, htmlLength=${html.length}, captchaSrcChanged=${Boolean(beforeCaptchaSrc && afterCaptchaSrc && beforeCaptchaSrc !== afterCaptchaSrc)}, safeFields=${JSON.stringify(safeFormState)}`);
                    if (interesting.length) console.log(`INFO  [POST validation elements] ${host}: ${JSON.stringify(interesting)}`);
                    if (snippets.length) console.log(`INFO  [POST keyword context] ${host}: ${JSON.stringify(snippets)}`);
                } catch (err) {
                    console.log(`WARN  [POST response diagnostic] ${err?.message || err}`);
                }
            });

            return page;
        };

        return context;
    };

    return browser;
};

await import('./main-v9.js');

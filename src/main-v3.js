// Thin runtime hardening layer around main-v2.js.
// It keeps the Actor's existing scraping/sending logic intact, while fixing
// two Mobile.bg-specific issues:
// 1) legacy 2Captcha image tasks must preserve letter case and are exactly 6 chars;
// 2) Mobile.bg may communicate POST success/error through JS dialogs/scripts,
//    which are invisible to body.innerText().

import playwright from 'playwright';

// ---------------------------------------------------------------------------
// 2Captcha legacy API hardening
// ---------------------------------------------------------------------------
const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);

    // main-v2 sends image CAPTCHAs through the legacy /in.php base64 API.
    // Mobile.bg CAPTCHA values are 6 alphanumeric chars with mixed case, so
    // explicitly tell workers that case matters and constrain the length.
    if (/^https:\/\/2captcha\.com\/in\.php(?:\?|$)/i.test(url)
        && init?.method?.toUpperCase() === 'POST'
        && init.body instanceof URLSearchParams
        && init.body.get('method') === 'base64') {
        const body = new URLSearchParams(init.body);
        body.set('regsense', '1');
        body.set('min_len', '6');
        body.set('max_len', '6');
        body.set('phrase', '0');
        body.set('numeric', '0');
        body.set('textinstructions', 'Enter exactly the 6 characters shown. Uppercase/lowercase letters must match exactly.');
        return nativeFetch(input, { ...init, body });
    }

    return nativeFetch(input, init);
};

// ---------------------------------------------------------------------------
// Playwright hardening: capture JS dialogs and POST response scripts.
// ---------------------------------------------------------------------------
const originalLaunch = playwright.chromium.launch.bind(playwright.chromium);

playwright.chromium.launch = async (...launchArgs) => {
    const browser = await originalLaunch(...launchArgs);
    const originalNewContext = browser.newContext.bind(browser);

    browser.newContext = async (...contextArgs) => {
        const context = await originalNewContext(...contextArgs);
        const originalNewPage = context.newPage.bind(context);

        context.newPage = async (...pageArgs) => {
            const page = await originalNewPage(...pageArgs);
            page.__bgDealerDialogs = [];
            page.__bgDealerPostSignals = [];

            // Mobile.bg can use alert() after a form POST. Capture it and
            // dismiss it so headless Chromium never blocks on the dialog.
            page.on('dialog', async (dialog) => {
                try {
                    const message = dialog.message() || '';
                    page.__bgDealerDialogs.push(message);
                    console.log(`INFO  [Mobile.bg dialog] ${message}`);
                } catch {}
                await dialog.dismiss().catch(() => null);
            });

            // Capture only relevant text from scripts returned by document POSTs.
            // This lets main-v2's existing success/error patterns see messages
            // that are not visible in rendered innerText().
            page.on('response', async (response) => {
                try {
                    const request = response.request();
                    if (request.method().toUpperCase() !== 'POST' || request.resourceType() !== 'document') return;
                    const contentType = (response.headers()['content-type'] || '').toLowerCase();
                    if (!contentType.includes('text/html')) return;

                    const html = await response.text();
                    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
                        .map((m) => m[1])
                        .filter((s) => /alert\s*\(|изпрат|благодар|греш|невалид|код|captcha|успеш/i.test(s))
                        .join(' ')
                        .replace(/\s+/g, ' ')
                        .slice(0, 5000);

                    if (scripts) page.__bgDealerPostSignals.push(scripts);
                } catch {}
            });

            // main-v2 reads page.locator('body').innerText() to determine the
            // result. Enrich only that read with the captured non-visible server
            // signals. Also remove the static form label "Въведете кода", which
            // previously caused every CAPTCHA to be falsely logged as failed.
            const originalLocator = page.locator.bind(page);
            page.locator = (selector, ...locatorArgs) => {
                const locator = originalLocator(selector, ...locatorArgs);
                if (selector === 'body' && locator && typeof locator.innerText === 'function') {
                    const originalInnerText = locator.innerText.bind(locator);
                    locator.innerText = async (...innerTextArgs) => {
                        let text = await originalInnerText(...innerTextArgs);
                        text = String(text || '')
                            .replace(/въведете\s+кода\s*:?/gi, ' ')
                            .replace(/\s+/g, ' ');

                        const extra = [
                            ...(page.__bgDealerDialogs || []),
                            ...(page.__bgDealerPostSignals || []),
                        ].filter(Boolean).join(' ');

                        return extra ? `${text} ${extra}` : text;
                    };
                }
                return locator;
            };

            return page;
        };

        return context;
    };

    return browser;
};

await import('./main-v2.js');

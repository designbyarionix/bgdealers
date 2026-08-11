// Mobile.bg runtime hardening layer around main-v2.js.
// Adds stricter 2Captcha hints, captures POST/dialog signals, and infers
// successful form submission from server-side form reset when Mobile.bg
// returns HTTP 200 without an explicit success message.

import playwright from 'playwright';

const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);

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

function compact(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

function looksLikeContactFormText(text) {
    const value = compact(text).toLowerCase();
    return /изпрати\s+запитване/.test(value)
        || (/вашето\s+име/.test(value) && /запитване/.test(value));
}

function classifyControl(meta) {
    const hay = compact(`${meta.name || ''} ${meta.id || ''} ${meta.placeholder || ''} ${meta.label || ''}`).toLowerCase();
    const type = (meta.type || '').toLowerCase();
    if (type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button' || type === 'image') return null;
    if (/captcha|verification|verify|security|код/.test(hay)) return 'captcha';
    if (meta.tag === 'textarea' || /message|msg|comment|description|note|запитване|съобщение/.test(hay)) return 'message';
    if (/e-?mail|email|имейл|електронна\s+поща/.test(hay) || type === 'email') return 'email';
    if (/phone|телефон|мобилен|gsm|fone|mobile/.test(hay) || type === 'tel') return 'phone';
    if (/name|fullname|contact|име|фирма/.test(hay)) return 'name';
    return null;
}

async function snapshotContactForm(page, postedNames = null) {
    try {
        const forms = await page.$$eval('form', (nodes) => nodes.map((form, formIndex) => {
            const formText = (form.innerText || '').replace(/\s+/g, ' ').trim();
            const controls = [...form.querySelectorAll('input, textarea, select')].map((el) => {
                const id = el.id || '';
                let label = '';
                if (id) {
                    try {
                        const labelEl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                        if (labelEl) label = labelEl.innerText || '';
                    } catch {}
                }
                if (!label) {
                    let parent = el.parentElement;
                    for (let i = 0; i < 4 && parent; i += 1, parent = parent.parentElement) {
                        if (parent.tagName?.toLowerCase() === 'label') {
                            label = parent.innerText || '';
                            break;
                        }
                    }
                }
                return {
                    tag: el.tagName.toLowerCase(),
                    type: (el.type || '').toLowerCase(),
                    name: el.name || '',
                    id,
                    placeholder: el.getAttribute('placeholder') || '',
                    label,
                    value: el.value || '',
                    checked: typeof el.checked === 'boolean' ? el.checked : undefined,
                };
            });
            const captcha = form.querySelector('img[src*="captcha" i], img[class*="captcha" i], img[id*="captcha" i], img[alt*="captcha" i], img[title*="captcha" i]');
            return {
                formIndex,
                formText,
                action: form.action || '',
                method: (form.method || 'get').toLowerCase(),
                controls,
                captchaSrc: captcha?.getAttribute('src') || '',
            };
        }));

        const form = forms.find((item) => looksLikeContactFormText(item.formText));
        if (!form) return { present: false };

        const submittedNameSet = postedNames ? new Set(postedNames) : null;
        const semantic = [];
        for (const control of form.controls) {
            const key = classifyControl(control);
            if (!key || key === 'captcha') continue;
            if (submittedNameSet && control.name && !submittedNameSet.has(control.name)) continue;
            semantic.push({ key, name: control.name, hasValue: compact(control.value).length > 0 });
        }

        const meaningful = new Map();
        for (const item of semantic) {
            if (!meaningful.has(item.key)) meaningful.set(item.key, item);
        }

        const values = [...meaningful.values()];
        return {
            present: true,
            formIndex: form.formIndex,
            captchaSrc: form.captchaSrc,
            meaningfulFields: values.map((x) => x.key),
            preservedFields: values.filter((x) => x.hasValue).map((x) => x.key),
            clearedFields: values.filter((x) => !x.hasValue).map((x) => x.key),
        };
    } catch {
        return { present: false, inspectionFailed: true };
    }
}

function parsePostedNames(postData) {
    try {
        const params = new URLSearchParams(postData || '');
        return [...new Set([...params.keys()].filter(Boolean))];
    } catch {
        return [];
    }
}

function rawHtmlSignals(html) {
    const raw = String(html || '');
    const normalized = compact(raw.replace(/&nbsp;/gi, ' ').replace(/&#160;/g, ' '));
    const signals = [];

    const patterns = [
        /грешен\s+код/ig,
        /невалиден\s+код/ig,
        /неправилен\s+код/ig,
        /кодът\s+не\s+съвпада/ig,
        /невалидна\s+captcha/ig,
        /invalid\s+captcha/ig,
        /моля[, ]+опитайте\s+отново/ig,
        /успешно.{0,40}изпрат/ig,
        /запитването.{0,40}изпратено/ig,
        /съобщението.{0,40}изпратено/ig,
        /благодарим/ig,
    ];

    for (const re of patterns) {
        const matches = normalized.match(re);
        if (matches) signals.push(...matches.slice(0, 3));
    }
    return [...new Set(signals)].join(' ');
}

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
            page.__bgDealerLastPost = null;
            page.__bgDealerCaptchaLoadedAt = null;
            page.__bgDealerCaptchaUrl = null;

            page.on('dialog', async (dialog) => {
                try {
                    const message = dialog.message() || '';
                    page.__bgDealerDialogs.push(message);
                    console.log(`INFO  [Mobile.bg dialog] ${message}`);
                } catch {}
                await dialog.dismiss().catch(() => null);
            });

            page.on('request', (request) => {
                try {
                    if (request.method().toUpperCase() !== 'POST' || request.resourceType() !== 'document') return;
                    const postData = request.postData() || '';
                    const postedNames = parsePostedNames(postData);
                    const now = Date.now();
                    const captchaAgeMs = page.__bgDealerCaptchaLoadedAt ? now - page.__bgDealerCaptchaLoadedAt : null;
                    page.__bgDealerLastPost = {
                        requestUrl: request.url(),
                        startedAt: now,
                        postDataLength: postData.length,
                        postedNames,
                        captchaAgeMs,
                        responseStatus: null,
                        responseReceivedAt: null,
                        responseHtmlSignal: '',
                    };
                    const host = (() => { try { return new URL(page.url()).hostname; } catch { return page.url(); } })();
                    console.log(`INFO  [Форма state] ${host}: POST започна; полета=${postedNames.join(',') || '(неразпознати)'}, captchaAgeMs=${captchaAgeMs ?? 'unknown'}`);
                } catch {}
            });

            page.on('response', async (response) => {
                try {
                    const request = response.request();
                    const responseUrl = response.url();

                    if (/\/pcgi\/captcha\.cgi/i.test(responseUrl)) {
                        page.__bgDealerCaptchaLoadedAt = Date.now();
                        page.__bgDealerCaptchaUrl = responseUrl;
                    }

                    if (request.method().toUpperCase() !== 'POST' || request.resourceType() !== 'document') return;
                    const contentType = (response.headers()['content-type'] || '').toLowerCase();
                    let html = '';
                    if (contentType.includes('text/html')) html = await response.text().catch(() => '');

                    const scriptSignals = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
                        .map((m) => m[1])
                        .filter((s) => /alert\s*\(|изпрат|благодар|греш|невалид|код|captcha|успеш/i.test(s))
                        .join(' ')
                        .replace(/\s+/g, ' ')
                        .slice(0, 5000);
                    const htmlSignal = rawHtmlSignals(html);
                    if (scriptSignals) page.__bgDealerPostSignals.push(scriptSignals);
                    if (htmlSignal) page.__bgDealerPostSignals.push(htmlSignal);

                    if (page.__bgDealerLastPost) {
                        page.__bgDealerLastPost.responseStatus = response.status();
                        page.__bgDealerLastPost.responseReceivedAt = Date.now();
                        page.__bgDealerLastPost.responseHtmlSignal = htmlSignal;
                    }
                } catch {}
            });

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
                        ].filter(Boolean);

                        const post = page.__bgDealerLastPost;
                        if (post?.responseReceivedAt && post.responseStatus >= 200 && post.responseStatus < 400) {
                            const state = await snapshotContactForm(page, post.postedNames);
                            const meaningfulCount = state.meaningfulFields?.length || 0;
                            const clearedCount = state.clearedFields?.length || 0;
                            const preservedCount = state.preservedFields?.length || 0;
                            const strongReset = state.present && meaningfulCount >= 3 && clearedCount >= 3 && preservedCount <= 1;
                            const strongPreserved = state.present && meaningfulCount >= 3 && preservedCount >= 3;
                            const formGone = state.present === false && !state.inspectionFailed;

                            if (!post.stateLogged) {
                                const host = (() => { try { return new URL(page.url()).hostname; } catch { return page.url(); } })();
                                console.log(`INFO  [Форма state] ${host}: след POST status=${post.responseStatus}, formPresent=${state.present}, meaningful=${state.meaningfulFields?.join(',') || '-'}, cleared=${state.clearedFields?.join(',') || '-'}, preserved=${state.preservedFields?.join(',') || '-'}, captchaAgeMs=${post.captchaAgeMs ?? 'unknown'}`);
                                post.stateLogged = true;
                            }

                            if (strongReset || formGone) {
                                extra.push('успешно изпратено');
                            } else if (strongPreserved && post.responseHtmlSignal) {
                                if (/греш|невалид|неправил|опитайте/i.test(post.responseHtmlSignal)) extra.push('please try again');
                            }
                        }

                        return extra.length ? `${text} ${extra.join(' ')}` : text;
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

// v7 Mobile.bg runtime hardening.
// Keeps the paid 2Captcha-only flow from v5, but guarantees that the solved
// 6-character code is written into the actual visible "Код" input immediately
// before submit. Also logs a privacy-safe field mapping and the contact-form
// text after POST so server-side validation messages are visible.

import playwright from 'playwright';

const realLaunch = playwright.chromium.launch.bind(playwright.chromium);

function compact(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

playwright.chromium.launch = async (...launchArgs) => {
    const browser = await realLaunch(...launchArgs);
    const realNewContext = browser.newContext.bind(browser);

    browser.newContext = async (...contextArgs) => {
        const context = await realNewContext(...contextArgs);
        const realNewPage = context.newPage.bind(context);

        context.newPage = async (...pageArgs) => {
            const page = await realNewPage(...pageArgs);

            // Privacy-safe POST diagnostics: never print contact field values.
            page.on('request', (request) => {
                try {
                    if (request.method().toUpperCase() !== 'POST' || request.resourceType() !== 'document') return;
                    const params = new URLSearchParams(request.postData() || '');
                    const payload = [...params.entries()].map(([name, value]) => ({
                        name,
                        length: String(value || '').length,
                        // Only infrastructure/control values are safe/useful to print verbatim.
                        value: /^(act|accept\d*)$/i.test(name) ? String(value || '') : undefined,
                    }));
                    const host = new URL(request.url()).hostname;
                    console.log(`INFO  [POST mapping] ${host}: ${JSON.stringify(payload)}`);
                } catch {}
            });

            // Print only the contact-form text after a document POST. This is much
            // more useful than the first 250 chars of the whole page and exposes
            // inline validation messages returned by Mobile.bg.
            page.on('response', (response) => {
                try {
                    const request = response.request();
                    if (request.method().toUpperCase() !== 'POST' || request.resourceType() !== 'document') return;
                    setTimeout(async () => {
                        try {
                            const forms = page.locator('form');
                            const count = await forms.count();
                            for (let i = 0; i < count; i += 1) {
                                const form = forms.nth(i);
                                const text = compact(await form.innerText().catch(() => ''));
                                if (!/изпрати\s+запитване|вашето\s+име|въведете\s+кода/i.test(text)) continue;
                                const host = new URL(page.url()).hostname;
                                console.log(`INFO  [Форма response] ${host}: "${text.slice(0, 1200)}${text.length > 1200 ? '…' : ''}"`);
                                break;
                            }
                        } catch {}
                    }, 450);
                } catch {}
            });

            // Patch the Locator prototype once. This survives the additional
            // Playwright wrappers used by main-v4/main-v5.
            const sampleLocator = page.locator('body');
            const proto = Object.getPrototypeOf(sampleLocator);

            if (proto && !proto.__bgDealerCaptchaFieldPatch) {
                Object.defineProperty(proto, '__bgDealerCaptchaFieldPatch', {
                    value: true,
                    enumerable: false,
                    configurable: false,
                });

                const originalFill = proto.fill;
                const originalClick = proto.click;

                proto.fill = async function patchedFill(value, options) {
                    const result = await originalFill.call(this, value, options);
                    try {
                        const textValue = String(value ?? '');
                        if (/^[A-Za-z0-9]{6}$/.test(textValue)) {
                            const capture = await this.evaluate((el, solved) => {
                                const form = el.closest?.('form');
                                if (!form || !form.querySelector('img[src*="captcha" i], img[class*="captcha" i], img[id*="captcha" i], img[alt*="captcha" i], img[title*="captcha" i]')) return null;
                                const hay = `${el.getAttribute('name') || ''} ${el.id || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.parentElement?.innerText || ''}`.toLowerCase();
                                if (!/код|code|captcha|verify|security/.test(hay)) return null;
                                window.__bgDealerSolvedCaptcha = solved;
                                return {
                                    name: el.getAttribute('name') || '',
                                    id: el.id || '',
                                    placeholder: el.getAttribute('placeholder') || '',
                                };
                            }, textValue).catch(() => null);
                            if (capture) {
                                console.log(`INFO  [Captcha field] solution captured from field name=${capture.name || '-'}, id=${capture.id || '-'}, placeholder=${capture.placeholder || '-'}.`);
                            }
                        }
                    } catch {}
                    return result;
                };

                proto.click = async function patchedClick(options) {
                    try {
                        const diagnostic = await this.evaluate((el) => {
                            const tag = (el.tagName || '').toLowerCase();
                            const type = (el.getAttribute('type') || '').toLowerCase();
                            const buttonText = `${el.innerText || ''} ${el.getAttribute('value') || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
                            const isSubmit = type === 'submit' || /изпрати\s+запитването|изпрати\s+запитване/.test(buttonText);
                            if (!isSubmit) return null;

                            const form = el.form || el.closest?.('form');
                            if (!form) return null;
                            const captchaImg = form.querySelector('img[src*="captcha" i], img[class*="captcha" i], img[id*="captcha" i], img[alt*="captcha" i], img[title*="captcha" i]');
                            if (!captchaImg) return null;

                            const solution = String(window.__bgDealerSolvedCaptcha || '').trim();
                            const controls = [...form.querySelectorAll('input, textarea, select')];

                            const mapped = controls.map((control, index) => {
                                const name = control.getAttribute('name') || '';
                                const id = control.id || '';
                                const placeholder = control.getAttribute('placeholder') || '';
                                const aria = control.getAttribute('aria-label') || '';
                                const controlType = (control.getAttribute('type') || control.type || '').toLowerCase();
                                const parentText = (control.parentElement?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
                                return {
                                    index,
                                    name,
                                    id,
                                    type: controlType,
                                    placeholder,
                                    parentText,
                                    valueLength: String(control.value || '').length,
                                    checked: typeof control.checked === 'boolean' ? control.checked : undefined,
                                };
                            });

                            const scoreControl = (control) => {
                                const name = control.getAttribute('name') || '';
                                const id = control.id || '';
                                const placeholder = control.getAttribute('placeholder') || '';
                                const aria = control.getAttribute('aria-label') || '';
                                const typeValue = (control.getAttribute('type') || control.type || '').toLowerCase();
                                const parentText = control.parentElement?.innerText || '';
                                const hay = `${name} ${id} ${placeholder} ${aria} ${parentText}`.toLowerCase();
                                if (['hidden', 'checkbox', 'radio', 'submit', 'button', 'image', 'email', 'tel'].includes(typeValue)) return -1000;
                                let score = 0;
                                if (/код/.test(placeholder.toLowerCase())) score += 120;
                                if (/captcha/.test(hay)) score += 90;
                                if (/въведете\s+кода/.test(hay)) score += 80;
                                if (/код|code|verify|security/.test(hay)) score += 55;
                                if (Number(control.maxLength) === 6) score += 25;
                                if (typeValue === 'text' || !typeValue) score += 5;
                                try {
                                    const relation = captchaImg.compareDocumentPosition(control);
                                    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) score += 15;
                                } catch {}
                                return score;
                            };

                            let best = null;
                            let bestScore = -Infinity;
                            for (const control of controls) {
                                const score = scoreControl(control);
                                if (score > bestScore) {
                                    bestScore = score;
                                    best = control;
                                }
                            }

                            let corrected = false;
                            let captchaField = null;
                            if (best && bestScore >= 50 && /^[A-Za-z0-9]{6}$/.test(solution)) {
                                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                                if (best instanceof HTMLInputElement && setter) setter.call(best, solution);
                                else best.value = solution;
                                best.dispatchEvent(new Event('input', { bubbles: true }));
                                best.dispatchEvent(new Event('change', { bubbles: true }));
                                corrected = String(best.value || '') === solution;
                                captchaField = {
                                    name: best.getAttribute('name') || '',
                                    id: best.id || '',
                                    placeholder: best.getAttribute('placeholder') || '',
                                    score: bestScore,
                                    valueLength: String(best.value || '').length,
                                };
                            }

                            return {
                                tag,
                                type,
                                buttonText: buttonText.slice(0, 80),
                                solutionAvailable: /^[A-Za-z0-9]{6}$/.test(solution),
                                corrected,
                                captchaField,
                                controls: mapped,
                            };
                        }).catch(() => null);

                        if (diagnostic) {
                            console.log(`INFO  [Form controls] submit diagnostic=${JSON.stringify(diagnostic)}`);
                        }
                    } catch {}

                    return originalClick.call(this, options);
                };
            }

            return page;
        };

        return context;
    };

    return browser;
};

await import('./main-v5.js');

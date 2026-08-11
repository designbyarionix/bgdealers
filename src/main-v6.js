// v6 runtime layer for Mobile.bg contact forms.
// Goals:
// - keep CAPTCHA fresh by trying a fast local OCR consensus first;
// - fall back to the proven legacy 2Captcha flow when OCR is uncertain;
// - preserve all v4 form-state diagnostics;
// - force at least 120 seconds for remote CAPTCHA solving.

import { Actor } from 'apify';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';

const originalGetInput = Actor.getInput.bind(Actor);
Actor.getInput = async (...args) => {
    const value = (await originalGetInput(...args)) ?? {};
    const configured = Number(value.formSubmitTimeoutMs || 0);
    return {
        ...value,
        formSubmitTimeoutMs: Math.max(120000, Number.isFinite(configured) ? configured : 0),
    };
};

const nativeFetch = globalThis.fetch.bind(globalThis);
const localSolutions = new Map();
let localTaskCounter = 910000000000000;

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

function cleanCandidate(text) {
    return String(text || '').replace(/[^A-Za-z0-9]/g, '').trim();
}

async function prepareVariant(buffer, threshold = null) {
    let image = sharp(buffer).grayscale();
    const meta = await image.metadata();
    const width = Math.max(120, Number(meta.width || 180));
    image = image
        .resize({ width: Math.min(1200, width * 4), withoutEnlargement: false })
        .normalise()
        .sharpen();
    if (threshold !== null) image = image.threshold(threshold);
    return await image.png().toBuffer();
}

async function recognizeVariant(buffer) {
    const result = await Tesseract.recognize(buffer, 'eng', { logger: () => {} });
    return {
        text: cleanCandidate(result?.data?.text),
        confidence: Number(result?.data?.confidence || 0),
    };
}

async function solveLocallyConsensus(imageBase64) {
    const started = Date.now();
    try {
        const source = Buffer.from(imageBase64, 'base64');
        const [variantA, variantB] = await Promise.all([
            prepareVariant(source, null),
            prepareVariant(source, 150),
        ]);

        const [a, b] = await Promise.all([
            recognizeVariant(variantA),
            recognizeVariant(variantB),
        ]);

        const aValid = /^[A-Za-z0-9]{6}$/.test(a.text);
        const bValid = /^[A-Za-z0-9]{6}$/.test(b.text);
        let accepted = null;
        let reason = 'no-consensus';

        if (aValid && bValid && a.text === b.text) {
            accepted = a.text;
            reason = 'two-pass-consensus';
        } else if (aValid && a.confidence >= 88) {
            accepted = a.text;
            reason = 'high-confidence-pass-a';
        } else if (bValid && b.confidence >= 88) {
            accepted = b.text;
            reason = 'high-confidence-pass-b';
        }

        const elapsedMs = Date.now() - started;
        console.log(`INFO  [Local OCR] A="${a.text || '-'}" (${a.confidence.toFixed(0)}%), B="${b.text || '-'}" (${b.confidence.toFixed(0)}%), elapsed=${elapsedMs}ms, result=${accepted ? `ACCEPT ${accepted} (${reason})` : 'fallback-to-2captcha'}`);
        return accepted;
    } catch (err) {
        console.log(`WARN  [Local OCR] failed: ${err.message}; falling back to 2Captcha.`);
        return null;
    }
}

globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input?.url || String(input);
    let url;
    try { url = new URL(rawUrl); } catch { return nativeFetch(input, init); }

    // v4 adds regsense/min_len/max_len before this wrapper receives the request.
    if (url.hostname === '2captcha.com' && url.pathname === '/in.php'
        && String(init?.method || 'GET').toUpperCase() === 'POST'
        && init.body instanceof URLSearchParams
        && init.body.get('method') === 'base64') {
        const image = init.body.get('body');
        if (image) {
            const local = await solveLocallyConsensus(image);
            if (local) {
                const taskId = ++localTaskCounter;
                localSolutions.set(String(taskId), { text: local, createdAt: Date.now() });
                console.log(`INFO  [Local OCR] local CAPTCHA task created: ${taskId}`);
                return jsonResponse({ status: 1, request: String(taskId) });
            }
        }

        console.log('INFO  [Captcha] Local OCR uncertain -> using remote 2Captcha legacy worker.');
        return nativeFetch(input, init);
    }

    if (url.hostname === '2captcha.com' && url.pathname === '/res.php' && url.searchParams.get('action') === 'get') {
        const id = url.searchParams.get('id');
        const local = id ? localSolutions.get(String(id)) : null;
        if (local) {
            localSolutions.delete(String(id));
            console.log(`INFO  [Local OCR] CAPTCHA result returned after ${Date.now() - local.createdAt}ms.`);
            return jsonResponse({ status: 1, request: local.text });
        }
    }

    return nativeFetch(input, init);
};

await import('./main-v4.js');

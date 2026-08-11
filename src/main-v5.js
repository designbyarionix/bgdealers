// v5 runtime layer:
// - forces at least 120s for normal image CAPTCHA solving (2Captcha's recommended default)
// - transparently upgrades the legacy in.php/res.php calls used by main-v2/v3 to 2Captcha API v2
// - keeps all existing Mobile.bg form-state diagnostics from v4

import { Actor } from 'apify';

// Existing saved Apify inputs may still contain formSubmitTimeoutMs=60000.
// main-v2 caps CAPTCHA polling to this value, so normalize it before main-v2 reads input.
const originalGetInput = Actor.getInput.bind(Actor);
Actor.getInput = async (...args) => {
    const value = (await originalGetInput(...args)) ?? {};
    const configured = Number(value.formSubmitTimeoutMs || 0);
    return {
        ...value,
        formSubmitTimeoutMs: Math.max(120000, Number.isFinite(configured) ? configured : 0),
    };
};

// main-v3 adds Mobile.bg-specific params (case-sensitive, exactly 6 chars) to the
// legacy /in.php request. We intercept that request and create a modern API v2 task.
const upstreamFetch = globalThis.fetch.bind(globalThis);

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
    });
}

globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input?.url || String(input);
    let url;
    try { url = new URL(rawUrl); } catch { return upstreamFetch(input, init); }

    // Legacy image upload -> API v2 ImageToTextTask.
    if (url.hostname === '2captcha.com' && url.pathname === '/in.php'
        && String(init?.method || 'GET').toUpperCase() === 'POST'
        && init.body instanceof URLSearchParams
        && init.body.get('method') === 'base64') {
        const body = init.body;
        const clientKey = body.get('key');
        const image = body.get('body');
        if (!clientKey || !image) {
            return jsonResponse({ status: 0, request: 'ERROR_BAD_PARAMETERS' });
        }

        const numericLegacy = Number(body.get('numeric') || 0);
        const task = {
            type: 'ImageToTextTask',
            body: image,
            phrase: body.get('phrase') === '1',
            case: body.get('regsense') === '1',
            numeric: Number.isFinite(numericLegacy) ? numericLegacy : 0,
            math: body.get('calc') === '1',
            minLength: Number(body.get('min_len') || 0),
            maxLength: Number(body.get('max_len') || 0),
        };
        const comment = body.get('textinstructions');
        if (comment) task.comment = comment.slice(0, 140);

        const response = await upstreamFetch('https://api.2captcha.com/createTask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientKey, task, languagePool: 'en' }),
        });
        const result = await response.json();
        if (!result || result.errorId) {
            const error = result?.errorCode || result?.errorDescription || 'ERROR_2CAPTCHA_CREATE_TASK';
            console.log(`WARN  [2Captcha v2] createTask failed: ${error}`);
            return jsonResponse({ status: 0, request: String(error) });
        }

        console.log(`INFO  [2Captcha v2] image task created: ${result.taskId}`);
        return jsonResponse({ status: 1, request: String(result.taskId) });
    }

    // Legacy polling -> API v2 getTaskResult.
    if (url.hostname === '2captcha.com' && url.pathname === '/res.php'
        && url.searchParams.get('action') === 'get') {
        const clientKey = url.searchParams.get('key');
        const taskIdRaw = url.searchParams.get('id');
        const taskId = Number(taskIdRaw);
        if (!clientKey || !Number.isFinite(taskId)) {
            return jsonResponse({ status: 0, request: 'ERROR_BAD_PARAMETERS' });
        }

        const response = await upstreamFetch('https://api.2captcha.com/getTaskResult', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientKey, taskId }),
        });
        const result = await response.json();
        if (!result || result.errorId) {
            const error = result?.errorCode || result?.errorDescription || 'ERROR_2CAPTCHA_GET_RESULT';
            return jsonResponse({ status: 0, request: String(error) });
        }
        if (result.status !== 'ready') {
            return jsonResponse({ status: 0, request: 'CAPCHA_NOT_READY' });
        }

        const solved = String(result?.solution?.text || '').trim();
        if (!solved) return jsonResponse({ status: 0, request: 'ERROR_EMPTY_CAPTCHA_RESULT' });
        console.log(`INFO  [2Captcha v2] image task solved in ${Math.max(0, (result.endTime || 0) - (result.createTime || 0))}s.`);
        return jsonResponse({ status: 1, request: solved });
    }

    return upstreamFetch(input, init);
};

await import('./main-v4.js');

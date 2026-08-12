const actorId = 'queueing_tiger~bgdealers';
const token = process.env.APIFY_TOKEN;
if (!token) throw new Error('APIFY_TOKEN secret is missing');

const api = 'https://api.apify.com/v2';
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${typeof body === 'string' ? body.slice(0, 1000) : JSON.stringify(body)}`);
  return body;
}

async function waitForRun(runId) {
  for (let i = 0; i < 90; i += 1) {
    const body = await requestJson(`${api}/actor-runs/${encodeURIComponent(runId)}?waitForFinish=20`);
    const run = body?.data || body;
    if (['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Timed out waiting for Actor run');
}

console.log('[diagnostic] Starting one-dealer Actor run with no request body.');
const started = await requestJson(`${api}/actors/${encodeURIComponent(actorId)}/runs?waitForFinish=0`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '',
});
const run = started?.data || started;
if (!run?.id) throw new Error(`Run did not return an id: ${JSON.stringify(started)}`);
console.log(`[diagnostic] Run id: ${run.id}`);

const finished = await waitForRun(run.id);
console.log(`[diagnostic] Final status: ${finished.status}`);

const logResponse = await fetch(`${api}/logs/${encodeURIComponent(run.id)}`, { headers });
const logText = await logResponse.text();
await import('node:fs/promises').then((fs) => fs.writeFile('apify-run.log', logText, 'utf8'));
console.log('----- APIFY RUN LOG -----');
console.log(logText);
console.log('----- END APIFY RUN LOG -----');

if (finished.status !== 'SUCCEEDED') process.exitCode = 1;

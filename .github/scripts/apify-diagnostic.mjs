const actorId = 'queueing_tiger~bgdealers';
const token = process.env.APIFY_TOKEN;
if (!token) throw new Error('APIFY_TOKEN secret is missing');

const api = 'https://api.apify.com/v2';
const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
const terminal = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

async function requestJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${typeof body === 'string' ? body.slice(0, 1500) : JSON.stringify(body)}`);
  return body;
}

async function getText(url) {
  const response = await fetch(url, { headers });
  return await response.text();
}

async function waitForBuild(buildId, initial) {
  let build = initial;
  for (let i = 0; i < 12 && !terminal.has(build?.status); i += 1) {
    const body = await requestJson(`${api}/actor-builds/${encodeURIComponent(buildId)}?waitForFinish=60`);
    build = body?.data || body;
    console.log(`[diagnostic] Build status: ${build.status}`);
  }
  return build;
}

async function buildLatest() {
  console.log('[diagnostic] Building latest GitHub source in Apify...');
  const candidates = ['0.0', '0.1'];
  let lastError;
  for (const version of candidates) {
    try {
      const body = await requestJson(`${api}/actors/${encodeURIComponent(actorId)}/builds?version=${encodeURIComponent(version)}&tag=latest&useCache=1&waitForFinish=60`, { method: 'POST' });
      let build = body?.data || body;
      console.log(`[diagnostic] Build id: ${build.id}; version=${version}; status=${build.status}`);
      build = await waitForBuild(build.id, build);
      if (build.status !== 'SUCCEEDED') {
        const buildLog = await getText(`${api}/logs/${encodeURIComponent(build.id)}`);
        console.log('----- APIFY BUILD LOG -----');
        console.log(buildLog);
        console.log('----- END APIFY BUILD LOG -----');
        throw new Error(`Apify build ${build.id} finished with ${build.status}`);
      }
      return build;
    } catch (err) {
      lastError = err;
      console.log(`[diagnostic] Build with version=${version} failed: ${err.message}`);
    }
  }
  throw lastError || new Error('Could not build Actor');
}

async function waitForRun(runId) {
  let last;
  for (let i = 0; i < 30; i += 1) {
    const body = await requestJson(`${api}/actor-runs/${encodeURIComponent(runId)}?waitForFinish=20`);
    last = body?.data || body;
    console.log(`[diagnostic] Run status: ${last.status}`);
    if (terminal.has(last.status)) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for Actor run; last status=${last?.status || 'unknown'}`);
}

const build = await buildLatest();
console.log(`[diagnostic] Using successful build ${build.id}.`);

console.log('[diagnostic] Starting one-dealer Actor run with no request body.');
const started = await requestJson(`${api}/actors/${encodeURIComponent(actorId)}/runs?build=latest&timeout=300`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '',
});
const run = started?.data || started;
if (!run?.id) throw new Error(`Run did not return an id: ${JSON.stringify(started)}`);
console.log(`[diagnostic] Run id: ${run.id}; build=${run.buildId || 'unknown'}`);

const finished = await waitForRun(run.id);
console.log(`[diagnostic] Final status: ${finished.status}`);

const logText = await getText(`${api}/logs/${encodeURIComponent(run.id)}`);
await import('node:fs/promises').then((fs) => fs.writeFile('apify-run.log', logText, 'utf8'));
console.log('----- APIFY RUN LOG -----');
console.log(logText);
console.log('----- END APIFY RUN LOG -----');

if (finished.status !== 'SUCCEEDED') process.exitCode = 1;

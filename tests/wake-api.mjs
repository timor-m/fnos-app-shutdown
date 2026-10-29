// Run after npm run build. Uses an isolated data directory and an ephemeral localhost port.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
const directory = await mkdtemp(join(tmpdir(), 'fnos-wake-api-'));
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.execPath, ['scripts/start.mjs'], { env: { ...process.env, PORT: String(port), STORAGE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
const base = `http://127.0.0.1:${port}/app/fnos-app-shutdown/api/wake`;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    child.stdout.on('data', data => { if (data.toString().includes('Nitro listening')) { clearTimeout(timer); resolve(); } });
  });
  const get = async () => (await (await fetch(base)).json()).data;
  const put = (revision, config, contentType = 'application/json') => fetch(base, { method: 'PUT', headers: { 'content-type': contentType }, body: JSON.stringify({ revision, config }) });
  let state = await get();
  assert.equal(state.config.enabled, false);
  assert.equal(state.revision, 'missing');
  const config = { ...state.config, plans: [{ id: 'test', enabled: true, time: '08:00', weekdays: [1,2,3,4,5], note: '测试计划' }] };
  let response = await put(state.revision, config);
  assert.equal(response.status, 200);
  state = (await response.json()).data;
  assert.equal(state.preview.length, 5);
  const concurrent = await Promise.all(['rtc1', 'rtc2'].map(device => put(state.revision, { ...config, device })));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200,409]);
  state = await get();
  assert.equal((await put(state.revision, { ...config, device: '../../etc' })).status, 400);
  assert.equal((await put(state.revision, config, 'text/plain')).status, 415);
  assert.equal((await put(state.revision, { ...config, plans: ['x'.repeat(70000)] })).status, 413);
  assert.equal((await put(state.revision, { ...config, plans: [...config.plans, { ...config.plans[0], id: 'duplicate' }] })).status, 400);
  await writeFile(join(directory, 'wake.json'), '{broken');
  state = await get();
  assert.ok(state.config_error);
  assert.equal(state.config.enabled, false);
  assert.equal((await put(state.revision, config)).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'wake.json'), 'utf8')), config);
  console.log('PASS wake API: defaults, persistence, preview, concurrent revision conflict, validation, content-type/size limits, corrupt-config recovery');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
  await rm(directory, { recursive: true, force: true });
}

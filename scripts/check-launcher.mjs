// Real service lifecycle checks with isolated ports, MQTT, accounts and databases.
// Prerequisites: install.ps1 / bash install.sh (core-only is sufficient).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, '.runtime'), { recursive: true });
const temporary = mkdtempSync(join(root, '.runtime/launcher-check-'));
const launcher = join(root, 'scripts/project.mjs');

async function freePort() {
  const listener = createServer();
  await new Promise((yes, no) => { listener.once('error', no); listener.listen(0, '127.0.0.1', yes); });
  const port = listener.address().port;
  await new Promise((yes) => listener.close(yes));
  return port;
}
const ports = new Set();
while (ports.size < 5) ports.add(await freePort());
const [mqttPort, aiPort, backendPort, frontendPort, cameraPort] = ports;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const env = { ...process.env,
  PROJECT_RUNTIME_DIR: temporary,
  MQTT_URL: `mqtt://127.0.0.1:${mqttPort}`,
  AI_HOST: '127.0.0.1', AI_PORT: String(aiPort), AI_SERVICE_URL: `http://127.0.0.1:${aiPort}`,
  AI_SERVICE_TOKEN: randomBytes(24).toString('hex'),
  PORT: String(backendPort), FRONTEND_PORT: String(frontendPort), SIMULATOR_CAMERA_PORT: String(cameraPort),
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64'),
  AUTH_DATABASE_PATH: join(temporary, 'auth.db'), TELEMETRY_DATABASE_PATH: join(temporary, 'telemetry.db'),
  SETTINGS_DATABASE_PATH: join(temporary, 'settings.db'), ANOMALY_MODEL: join(temporary, 'untrained.joblib'),
  FACE_RECOGNITION_ENABLED: 'false', VISION_AUTO_START: 'false',
};
// Deliberately derive these from FRONTEND_PORT, even if the caller exported other settings.
delete env.BETTER_AUTH_URL; delete env.FRONTEND_ORIGINS;

function run(parameters, expected = 0, program = process.execPath, cwd = temporary, extraEnv = {}) {
  return new Promise((yes, no) => {
    const child = spawn(program, parameters, { cwd, env: { ...env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
    child.once('error', no);
    child.once('exit', (code) => {
      try { assert.equal(code, expected, output); yes(output); } catch (error) { no(error); }
    });
  });
}
const state = () => JSON.parse(readFileSync(join(temporary, 'project.json'), 'utf8'));
async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
}
async function closed(port) {
  try {
    const { connect } = await import('node:net');
    return await new Promise((yes) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); yes(false); });
      socket.once('error', () => yes(true));
    });
  } catch { return true; }
}

let foreign;
const foreignSockets = new Set();
try {
  await run([launcher, 'start', '--simulate']);
  const initial = state();
  assert.equal(initial.phase, 'ready');
  assert.equal(initial.mode, 'simulation');
  assert.deepEqual(initial.services.map((s) => s.name), ['mosquitto', 'ai', 'backend', 'frontend', 'simulator']);
  assert.ok(initial.services.every((s) => !s.reused));
  const secondStart = await run([launcher, 'start', '--simulate']);
  assert.match(secondStart, /ready/);
  assert.equal(state().instance, initial.instance, 'Second start must reuse its supervisor.');
  await run([launcher, 'start', '--no-esp'], 1);
  await run([launcher, 'start', '--simulate'], 1, process.execPath, temporary, { PORT: String(await freePort()) });
  assert.equal((await fetch(`http://127.0.0.1:${initial.controlPort}/status`)).status, 401);
  console.log('PASS startup from another directory, AI included, idempotence, mode checks, private control API.');

  const email = 'launcher-test@sentinel.test';
  const password = randomBytes(24).toString('base64');
  await run(['--env-file-if-exists=.env', '--import', 'tsx', 'src/cli/create-user.ts', email, 'Launcher test'],
    0, process.execPath, join(root, 'iot-backend'), { AUTH_USER_PASSWORD: password });
  const login = await fetch(`${frontendUrl}/api/auth/sign-in/email`, {
    method: 'POST', headers: { Origin: frontendUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200, await login.text());
  const cookie = login.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ');
  assert.ok(cookie);
  const get = async (path) => {
    const response = await fetch(frontendUrl + path, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); return response.json();
  };
  await until(async () => (await get('/api/readings')).readings.length > 0, 'MQTT telemetry');
  await until(async () => (await get('/api/ai/status')).online, 'AI connection');
  await until(async () => (await get('/api/ai/history')).predictions.length > 0, 'AI persisted predictions');
  assert.equal((await get('/api/ai/status')).camera_source, 'external');
  const camera = await fetch(`${frontendUrl}/api/camera/stream`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(5000) });
  assert.equal(camera.status, 200); await camera.body.cancel();
  console.log('PASS custom ports, account/login, Vite API proxy, MQTT -> backend -> AI -> persisted predictions, camera relay.');

  await run([launcher, 'stop']);
  for (const port of ports) await until(() => closed(port), `shutdown port ${port}`);
  await run([launcher, 'stop']);
  console.log('PASS complete process-tree shutdown and repeated stop.');

  foreign = createServer((socket) => {
    foreignSockets.add(socket);
    socket.once('close', () => foreignSockets.delete(socket));
    socket.on('error', () => {}); // Health clients may close before reading this unrelated service.
    socket.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\noccupied');
  });
  await new Promise((yes, no) => { foreign.once('error', no); foreign.listen(frontendPort, '127.0.0.1', yes); });
  await run([launcher, 'start', '--no-esp'], 1);
  await until(() => state().phase === 'failed', 'failed startup cleanup');
  for (const port of [mqttPort, aiPort, backendPort]) await until(() => closed(port), `rollback port ${port}`);
  assert.equal(await closed(frontendPort), false, 'Foreign process must survive rollback.');
  console.log('PASS occupied port rejection, rollback of owned services, foreign service preserved.');

  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (existsSync(bash)) {
    for (const name of ['install', 'run', 'stop']) await run(['-n', join(root, `${name}.sh`)], 0, bash);
    await run([join(root, 'stop.sh')], 0, bash);
    console.log('PASS Bash syntax and stop wrapper from another directory.');
  }
  if (process.platform === 'win32') {
    await run(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'stop.ps1')], 0, 'powershell.exe');
    console.log('PASS PowerShell wrapper from another directory.');
  }
} finally {
  await run([launcher, 'stop']).catch((error) => console.error(`Cleanup: ${error.message}`));
  for (const socket of foreignSockets) socket.destroy();
  if (foreign) await new Promise((yes) => foreign.close(yes));
}
writeFileSync(join(temporary, 'result.json'), JSON.stringify({ result: 'passed', ports: [...ports] }, null, 2));
console.log(`PASS launcher lifecycle. Logs: ${temporary}`);

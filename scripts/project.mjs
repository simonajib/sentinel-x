// Shared local installer and service supervisor. No shell-specific process/PID tools.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = fileURLToPath(import.meta.url);
const windows = process.platform === 'win32';
const runtime = process.env.PROJECT_RUNTIME_DIR ? resolve(process.env.PROJECT_RUNTIME_DIR) : join(root, '.runtime');
const statePath = join(runtime, 'project.json');
// A per-directory control port also prevents two simultaneous starts of this project.
const controlPort = 45000 + createHash('sha256').update(windows ? runtime.toLowerCase() : runtime).digest().readUInt16BE() % 15000;
const backend = join(root, 'iot-backend');
const frontend = join(root, 'iot-frontend');
const ai = join(root, 'ai');
const python = join(ai, '.venv', windows ? 'Scripts/python.exe' : 'bin/python');
const [command = 'help', ...args] = process.argv.slice(2);

function assertNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Node.js 22.13 or newer is required.');
}

function envFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : {};
}

function checked(program, parameters, cwd = root, env = process.env) {
  const result = spawnSync(program, parameters, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed (exit ${result.status}).`);
}

function findProgram(name, extra = []) {
  for (const candidate of extra) if (candidate && existsSync(candidate)) return candidate;
  const result = spawnSync(windows ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}

function validateArgs(allowed) {
  for (let i = 0; i < args.length; i++) {
    if (!allowed.includes(args[i])) throw new Error(`Unknown option: ${args[i]}. Run node scripts/project.mjs help.`);
    if (args[i] === '--port' && (!args[++i] || args[i].startsWith('--'))) throw new Error('--port requires a serial port, for example COM7.');
  }
}

function readState() {
  try { return JSON.parse(readFileSync(statePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error(`Cannot read ${statePath}: ${error.message}`); }
}

async function control(state, path = '/status') {
  if (!state || state.root !== root || state.controlPort !== controlPort || typeof state.token !== 'string') return undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${controlPort}${path}`, {
      method: path === '/stop' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${state.token}` }, signal: AbortSignal.timeout(1500),
    });
    const status = await response.json();
    return response.ok && status.root === root && status.instance === state.instance ? status : undefined;
  } catch { return undefined; }
}

async function install() {
  validateArgs(['--core-only', '--skip-node-install', '--skip-python-install', '--with-tests', '--face-models']);
  if (await control(readState())) throw new Error('Project is running. Stop it before reinstalling dependencies.');
  mkdirSync(runtime, { recursive: true });
  const mosquitto = findProgram('mosquitto', [process.env.MOSQUITTO_PATH,
    windows && join(process.env.ProgramFiles ?? 'C:/Program Files', 'mosquitto/mosquitto.exe'),
    !windows && '/opt/homebrew/sbin/mosquitto', !windows && '/usr/local/sbin/mosquitto']);
  if (!mosquitto) {
    const brew = process.platform === 'darwin' && findProgram('brew');
    if (brew) checked(brew, ['install', 'mosquitto']);
    else throw new Error('Install Mosquitto first (Windows: https://mosquitto.org/download/; Linux: your package manager). Or set MOSQUITTO_PATH.');
  }
  const backendEnvPath = join(backend, '.env');
  let contents = readFileSync(existsSync(backendEnvPath) ? backendEnvPath : join(backend, '.env.example'), 'utf8');
  if (!envFile(backendEnvPath).BETTER_AUTH_SECRET) {
    const oldSecret = join(runtime, 'auth-secret');
    const secret = existsSync(oldSecret) ? readFileSync(oldSecret, 'utf8').trim() : randomBytes(32).toString('base64');
    if (secret.length < 32) throw new Error('The existing .runtime/auth-secret is invalid. Restore a valid session secret.');
    contents = /^BETTER_AUTH_SECRET=.*$/m.test(contents)
      ? contents.replace(/^BETTER_AUTH_SECRET=.*$/m, `BETTER_AUTH_SECRET=${secret}`)
      : `${contents}\nBETTER_AUTH_SECRET=${secret}\n`;
  }
  writeFileSync(backendEnvPath, contents, { mode: 0o600 });
  if (!existsSync(join(ai, '.env'))) writeFileSync(join(ai, '.env'), readFileSync(join(ai, '.env.example')), { mode: 0o600 });
  if (!args.includes('--skip-node-install')) {
    // Invoke npm's JS entry directly on Windows; .cmd is not a native executable.
    const npm = windows ? [
      join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
      join(process.env.APPDATA ?? '', 'npm/node_modules/npm/bin/npm-cli.js'),
    ].find(existsSync) : findProgram('npm');
    if (!npm) throw new Error('npm was not found. Install Node.js with npm.');
    for (const directory of [backend, frontend]) checked(windows ? process.execPath : npm,
      windows ? [npm, 'ci'] : ['ci'], directory);
  }
  if (!existsSync(python)) {
    const launcher = findProgram(windows ? 'py' : 'python3.12') ?? findProgram(windows ? 'python' : 'python3');
    if (!launcher) throw new Error('Install Python 3.12 (x64 on Windows), then retry.');
    checked(launcher, [...(windows && /(?:^|[\\/])py(?:\.exe)?$/i.test(launcher) ? ['-3.12'] : []),
      '-c', 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 is required"']);
    checked(launcher, [...(windows && /(?:^|[\\/])py(?:\.exe)?$/i.test(launcher) ? ['-3.12'] : []), '-m', 'venv', join(ai, '.venv')]);
  }
  checked(python, ['-c', 'import sys; assert sys.version_info[:2] == (3, 12), "Python 3.12 is required"']);
  if (!args.includes('--skip-python-install')) {
    checked(python, ['-m', 'pip', 'install', '-r', join(ai, args.includes('--core-only') ? 'requirements-core.txt' : 'requirements.txt')]);
    checked(python, ['-m', 'pip', 'install', '-r', join(root, 'scripts/requirements-esp.txt')]);
    if (args.includes('--with-tests')) checked(python, ['-m', 'pip', 'install', '-r', join(ai, 'requirements-test.txt')]);
    checked(python, ['-m', 'pip', 'check']);
  }
  if (args.includes('--face-models')) checked(python, ['-m', 'app.vision.setup_faces'], ai);
  console.log('Installation ready. Start: .\\run.ps1 (PowerShell) or bash run.sh (Bash).');
  console.log('AI is included. Camera starts from the dashboard. Use --face-models to download facial models.');
}

function configuration() {
  const backendEnv = { ...envFile(join(backend, '.env')), ...process.env };
  const aiEnv = { ...envFile(join(ai, '.env')), ...process.env };
  const frontendPort = Number(process.env.FRONTEND_PORT ?? 5173);
  const backendPort = Number(backendEnv.PORT ?? 3001);
  const aiPort = Number(aiEnv.AI_PORT ?? 8001);
  const simulatorPort = Number(backendEnv.SIMULATOR_CAMERA_PORT ?? 8090);
  for (const port of [frontendPort, backendPort, aiPort, simulatorPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Service ports must be integers between 1 and 65535.');
  }
  const aiHost = aiEnv.AI_HOST ?? '127.0.0.1';
  const localAiHost = ({ '0.0.0.0': '127.0.0.1', '::': '::1' })[aiHost] ?? aiHost;
  const aiUrl = `http://${localAiHost.includes(':') ? `[${localAiHost}]` : localAiHost}:${aiPort}`;
  if (backendEnv.AI_SERVICE_URL && backendEnv.AI_SERVICE_URL.replace(/\/$/, '') !== aiUrl) {
    throw new Error('AI_SERVICE_URL in iot-backend/.env must match AI_HOST/AI_PORT in ai/.env for the local launcher.');
  }
  if (backendEnv.AI_SERVICE_TOKEN && aiEnv.AI_SERVICE_TOKEN && backendEnv.AI_SERVICE_TOKEN !== aiEnv.AI_SERVICE_TOKEN) {
    throw new Error('AI_SERVICE_TOKEN differs between the backend and AI configuration.');
  }
  if ((backendEnv.BETTER_AUTH_SECRET ?? '').length < 32) throw new Error('Missing valid BETTER_AUTH_SECRET. Run install.ps1 or bash install.sh first.');
  const token = backendEnv.AI_SERVICE_TOKEN || aiEnv.AI_SERVICE_TOKEN || '';
  backendEnv.AI_SERVICE_TOKEN = aiEnv.AI_SERVICE_TOKEN = token;
  backendEnv.AI_SERVICE_URL = aiUrl;
  const simulate = args.includes('--simulate');
  if (simulate && (args.includes('--port') || args.includes('--no-esp'))) throw new Error('--simulate cannot be combined with --port or --no-esp.');
  if (simulate) {
    backendEnv.VISION_STREAM_URL = `http://127.0.0.1:${simulatorPort}/stream.mjpg`;
    backendEnv.MAIL_OUTBOX_DIR = join(runtime, 'mail');
    // A demo never opens the physical webcam or sends SMTP messages.
    aiEnv.VISION_AUTO_START = 'false';
    backendEnv.SMTP_HOST = '';
  }
  backendEnv.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? (process.env.FRONTEND_PORT ? undefined : backendEnv.BETTER_AUTH_URL) ?? `http://127.0.0.1:${frontendPort}`;
  backendEnv.FRONTEND_ORIGINS = process.env.FRONTEND_ORIGINS ?? (process.env.FRONTEND_PORT ? undefined : backendEnv.FRONTEND_ORIGINS) ?? `http://127.0.0.1:${frontendPort},http://localhost:${frontendPort}`;
  return { backendEnv, aiEnv, frontendPort, backendPort, simulatorPort, aiUrl, simulate,
    bridge: !simulate && !args.includes('--no-esp'),
    serialPort: args.includes('--port') ? args[args.indexOf('--port') + 1] : process.env.ESP_PORT,
    mqttUrl: backendEnv.MQTT_URL ?? 'mqtt://127.0.0.1:1883' };
}

async function portOpen(port, host = '127.0.0.1') {
  return new Promise((yes) => {
    const socket = connect({ port, host });
    const done = (value) => { socket.destroy(); yes(value); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

async function httpReady(url, predicate, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
    if (!response.ok) { await response.body?.cancel(); return false; }
    return await predicate(response);
  } catch { return false; }
}

async function mqttReady(url) {
  const require = createRequire(join(backend, 'package.json'));
  const mqtt = require('mqtt');
  return new Promise((yes) => {
    const client = mqtt.connect(url, { connectTimeout: 1500, reconnectPeriod: 0 });
    let finished = false;
    const timer = setTimeout(() => done(false), 2000);
    function done(value) {
      if (finished) return;
      finished = true; clearTimeout(timer); client.end(true); yes(value);
    }
    client.once('connect', () => done(true)); client.once('error', () => done(false));
  });
}

async function supervise() {
  const config = configuration();
  const children = [];
  const configurationHash = createHash('sha256').update(JSON.stringify([
    config.backendPort, config.frontendPort, config.simulatorPort, config.aiUrl, config.mqttUrl,
    config.bridge, config.serialPort ?? null, config.simulate,
  ])).digest('hex');
  const state = { root, instance: randomBytes(16).toString('hex'), token: randomBytes(32).toString('hex'),
    controlPort, pid: process.pid, phase: 'starting', mode: config.simulate ? 'simulation' : 'real',
    bridge: config.bridge, serialPort: config.serialPort ?? null,
    dashboardUrl: `http://127.0.0.1:${config.frontendPort}`, aiUrl: config.aiUrl,
    configurationHash,
    startedAt: new Date().toISOString(), services: [] };
  const publicState = () => { const { token, ...result } = state; return result; };
  function save() {
    writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    // OneDrive/Windows readers can briefly deny replacement of an open file.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(`${statePath}.tmp`, statePath); return; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 79) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }
  let stopping;
  const server = createServer((request, response) => {
    const expected = Buffer.from(`Bearer ${state.token}`);
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      response.writeHead(401).end(); return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/status') response.end(JSON.stringify(publicState()));
    else if (request.method === 'POST' && request.url === '/stop') {
      response.end(JSON.stringify(publicState())); void shutdown();
    } else response.writeHead(404).end('{}');
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(controlPort, '127.0.0.1', yes); });
  try { save(); }
  catch (error) { server.close(); throw error; }

  async function shutdown(error) {
    if (stopping) return stopping;
    stopping = (async () => {
      state.phase = error ? 'failed' : 'stopping';
      if (error) { state.error = error.message; console.error(error.stack ?? error.message); }
      const persist = () => { try { save(); } catch (failure) { console.error(`State update failed: ${failure.message}`); } };
      persist();
      const failures = [];
      for (const { child, name } of [...children].reverse()) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        console.log(`Stopping ${name} (${child.pid}).`);
        if (windows) {
          // Only descendants of children created by THIS live supervisor are targeted.
          const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
          for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
          if (child.exitCode === null && child.signalCode === null) failures.push(`Could not stop ${name}: ${result.error?.message ?? result.stderr}`);
        } else {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
          for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already exited */ }
        }
      }
      if (failures.length) {
        state.phase = 'stop-failed'; state.error = failures.join('\n'); persist();
        console.error(state.error);
        stopping = undefined;
        return;
      }
      state.phase = error ? 'failed' : 'stopped'; state.shutdownComplete = true; persist();
      server.close(); server.closeAllConnections();
      process.exitCode = error ? 1 : 0;
    })();
    return stopping;
  }
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  async function startService(name, program, parameters, directory, env, ready, occupied) {
    if (await ready()) {
      state.services.push({ name, reused: true }); save(); console.log(`${name}: existing service reused.`); return false;
    }
    if (occupied && await occupied()) throw new Error(`${name}: configured port is occupied by an unavailable or different service.`);
    if (stopping) throw new Error('Startup was interrupted.');
    const log = openSync(join(runtime, `${name}.log`), 'a');
    let child;
    try { child = spawn(program, parameters, { cwd: directory, env, stdio: ['ignore', log, log], detached: !windows, windowsHide: true }); }
    finally { closeSync(log); }
    let spawnError;
    child.on('error', (error) => { spawnError = error; });
    children.push({ child, name });
    state.services.push({ name, pid: child.pid, reused: false }); save();
    child.on('exit', (code, signal) => {
      if (['starting', 'ready'].includes(state.phase)) void shutdown(new Error(`${name} exited (${code ?? signal}). See ${join(runtime, `${name}.log`)}.`));
    });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) throw spawnError;
      if (stopping || child.exitCode !== null || child.signalCode !== null) throw new Error(`${name} stopped during startup. See ${join(runtime, `${name}.log`)}.`);
      if (await ready()) { console.log(`${name}: ready.`); return true; }
      await delay(250);
    }
    throw new Error(`${name}: startup timed out. See ${join(runtime, `${name}.log`)}.`);
  }

  try {
    const mqtt = new URL(config.mqttUrl);
    const mqttPort = Number(mqtt.port || (mqtt.protocol === 'mqtts:' ? 8883 : 1883));
    if (!await mqttReady(config.mqttUrl)) {
      if (mqtt.protocol !== 'mqtt:' || !['localhost', '127.0.0.1'].includes(mqtt.hostname) || mqtt.username || mqtt.password) {
        throw new Error('Configured MQTT broker is unavailable. Start that broker and check MQTT_URL.');
      }
      const broker = findProgram('mosquitto', [process.env.MOSQUITTO_PATH,
        windows && join(process.env.ProgramFiles ?? 'C:/Program Files', 'mosquitto/mosquitto.exe'),
        !windows && '/opt/homebrew/sbin/mosquitto', !windows && '/usr/local/sbin/mosquitto']);
      if (!broker) throw new Error('Mosquitto was not found. Run the installer or set MOSQUITTO_PATH.');
      const brokerConfig = join(runtime, 'mosquitto.conf');
      writeFileSync(brokerConfig, `listener ${mqttPort} 127.0.0.1\nallow_anonymous true\npersistence false\n`);
      await startService('mosquitto', broker, ['-c', brokerConfig, '-v'], root, process.env,
        () => mqttReady(config.mqttUrl), () => portOpen(mqttPort, mqtt.hostname));
    } else { state.services.push({ name: 'mosquitto', reused: true }); save(); }

    const aiHeaders = config.aiEnv.AI_SERVICE_TOKEN ? { Authorization: `Bearer ${config.aiEnv.AI_SERVICE_TOKEN}` } : {};
    await startService('ai', python, ['-u', '-m', 'app.main'], ai, config.aiEnv,
      async () => await httpReady(`${config.aiUrl}/health`, async (r) => (await r.json()).service === 'sentinel-x-ai') &&
        await httpReady(`${config.aiUrl}/status`, async (r) => typeof (await r.json()).model_loaded === 'boolean', aiHeaders),
      () => portOpen(Number(new URL(config.aiUrl).port), new URL(config.aiUrl).hostname.replace(/^\[|\]$/g, '')));
    const backendReady = () => httpReady(`http://127.0.0.1:${config.backendPort}/api/health`, async (r) => (await r.json()).status === 'ok');
    if (config.simulate && await portOpen(config.backendPort)) throw new Error('Simulation requires its own backend. Stop the existing backend first to keep real and simulated telemetry separate.');
    await startService('backend', process.execPath, ['--import', 'tsx', 'src/main.ts'], backend, config.backendEnv,
      backendReady, () => portOpen(config.backendPort));
    await startService('frontend', process.execPath, [join(frontend, 'node_modules/vite/bin/vite.js'),
      '--host', '127.0.0.1', '--port', String(config.frontendPort), '--strictPort'], frontend,
      { ...process.env, VITE_BACKEND_URL: `http://127.0.0.1:${config.backendPort}` },
      () => httpReady(`http://127.0.0.1:${config.frontendPort}/`, async (r) => (await r.text()).includes('<title>SENTINEL-X</title>')),
      () => portOpen(config.frontendPort));
    if (config.simulate) {
      await startService('simulator', process.execPath, ['--import', 'tsx', 'src/tools/simulator.ts'], backend, config.backendEnv,
        () => httpReady(config.backendEnv.VISION_STREAM_URL, async (r) => {
          const valid = r.headers.get('content-type')?.startsWith('multipart/x-mixed-replace');
          await r.body?.cancel(); return valid;
        }),
        () => portOpen(config.simulatorPort));
    } else if (config.bridge) {
      const bridgeArgs = [join(root, 'scripts/esp_serial_bridge.py'), '--mqtt-host', mqtt.hostname,
        '--mqtt-port', String(mqttPort), '--mqtt-topic', config.backendEnv.MQTT_TELEMETRY_TOPIC ?? 'esp8266/donnees'];
      if (mqtt.protocol !== 'mqtt:' || mqtt.username || mqtt.password) throw new Error('USB bridge requires local anonymous MQTT. Use --no-esp for a custom broker.');
      if (config.serialPort) bridgeArgs.push('--port', config.serialPort);
      const bridgeLog = join(runtime, 'esp-bridge.log');
      writeFileSync(bridgeLog, '');
      await startService('esp-bridge', python, ['-u', ...bridgeArgs], root, process.env,
        async () => existsSync(bridgeLog) && readFileSync(bridgeLog, 'utf8').includes('Lecture USB seule'));
    }
    if (stopping) return;
    state.phase = 'ready'; save(); console.log('All requested services are ready.');
  } catch (error) { await shutdown(error); }
}

function show(status) {
  console.log(`Sentinel-X: ${status.phase} (${status.mode}).`);
  for (const service of status.services) console.log(`  ${service.name}: ${service.reused ? 'existing service' : `managed PID ${service.pid}`}`);
  console.log(`Dashboard: ${status.dashboardUrl}\nAI: ${status.aiUrl}\nLogs: ${runtime}`);
  console.log('Create an account from the project root: npm --prefix iot-backend run user:create -- <email> "<name>"');
  console.log('Stop: .\\stop.ps1 (PowerShell) or bash stop.sh (Bash).');
}

async function start() {
  validateArgs(['--simulate', '--no-esp', '--port']);
  const config = configuration();
  for (const file of [python, join(backend, 'node_modules/tsx/dist/loader.mjs'), join(frontend, 'node_modules/vite/bin/vite.js')]) {
    if (!existsSync(file)) throw new Error(`Missing ${file}. Run install.ps1 or bash install.sh first.`);
  }
  const previous = await control(readState());
  if (previous) {
    if (previous.mode !== (args.includes('--simulate') ? 'simulation' : 'real')) throw new Error('Project is running in a different mode. Stop it before changing mode.');
    const configurationHash = createHash('sha256').update(JSON.stringify([
      config.backendPort, config.frontendPort, config.simulatorPort, config.aiUrl, config.mqttUrl,
      config.bridge, config.serialPort ?? null, config.simulate,
    ])).digest('hex');
    if (previous.configurationHash !== configurationHash) {
      throw new Error('Project is running with different options. Stop it before changing configuration.');
    }
    if (previous.phase !== 'ready') throw new Error(`Project is ${previous.phase}; wait or inspect supervisor.log.`);
    show(previous); return;
  }
  mkdirSync(runtime, { recursive: true });
  const logPath = join(runtime, 'supervisor.log');
  const log = openSync(logPath, 'w');
  const child = spawn(process.execPath, [script, 'supervise', ...args], {
    cwd: root, env: process.env, detached: true, windowsHide: true, stdio: ['ignore', log, log],
  });
  closeSync(log);
  let spawnError;
  child.on('error', (error) => { spawnError = error; }); child.unref();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const state = readState();
    if (state?.pid === child.pid) {
      if (state.phase === 'failed') throw new Error(`${state.error}\nSee ${logPath}`);
      if (state.phase === 'ready') { const live = await control(state); if (live) { show(live); return; } }
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Supervisor stopped. ${readFileSync(logPath, 'utf8').slice(-3000)}`);
    await delay(250);
  }
  const state = readState();
  if (state?.pid === child.pid) await control(state, '/stop');
  throw new Error(`Startup timed out. See ${logPath}`);
}

async function stop() {
  validateArgs([]);
  const state = readState();
  const live = await control(state);
  if (!live) {
    if (state && state.phase !== 'stopped' && !(state.phase === 'failed' && state.shutdownComplete)) throw new Error(`Cannot reach the recorded supervisor. See ${join(runtime, 'supervisor.log')}.`);
    console.log('No running services managed by this launcher. Existing services were left running.'); return;
  }
  if (!await control(state, '/stop')) throw new Error('Supervisor did not accept the stop request.');
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await control(state);
    if (status?.phase === 'stop-failed') throw new Error(status.error);
    if (!status) {
      const final = readState();
      if (final?.instance === state.instance && (final.phase === 'stopped' || (final.phase === 'failed' && final.shutdownComplete))) {
        console.log('Managed services stopped. Existing services were left running.'); return;
      }
      if (final?.instance === state.instance && final.phase === 'stop-failed') throw new Error(final.error);
    }
    await delay(200);
  }
  throw new Error(`Shutdown is still in progress. See ${join(runtime, 'supervisor.log')}.`);
}

try {
  assertNode();
  if (command === 'install') await install();
  else if (command === 'start') await start();
  else if (command === 'supervise') await supervise();
  else if (command === 'stop') await stop();
  else if (command === 'status') {
    const status = await control(readState());
    if (status) show(status); else { console.log('Project supervisor is not running.'); process.exitCode = 1; }
  } else if (command === 'help' || command === '--help') console.log(
    'node scripts/project.mjs install [--core-only] [--with-tests] [--face-models] [--skip-node-install] [--skip-python-install]\n' +
    'node scripts/project.mjs start [--simulate | --no-esp | --port COM7]\n' +
    'node scripts/project.mjs stop\nnode scripts/project.mjs status\n' +
    'PowerShell: install.ps1 / run.ps1 / stop.ps1. Bash: install.sh / run.sh / stop.sh.');
  else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }

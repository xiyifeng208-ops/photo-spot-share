import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const api = join(root, 'api');
const logs = join(root, 'work', 'logs');
const require = createRequire(join(api, 'package.json'));
const { parse } = require('dotenv');
const env = { ...parse(readFileSync(join(api, '.env'))), ...process.env };
const database = new URL(env.DATABASE_URL);
const apiUrl = `http://127.0.0.1:${env.PORT || 3000}`;
mkdirSync(logs, { recursive: true });

function reachable(host, port) {
  return new Promise((resolveConnection) => {
    const socket = createConnection({ host, port: Number(port) });
    const finish = (ok) => { socket.destroy(); resolveConnection(ok); };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function launch(command, args, cwd, name) {
  const log = openSync(join(logs, `${name}.log`), 'a');
  try {
    const child = spawn(command, args, {
      cwd, env, detached: true, windowsHide: true, stdio: ['ignore', log, log],
    });
    await new Promise((resolveLaunch, reject) => {
      child.once('spawn', resolveLaunch);
      child.once('error', reject);
    });
    child.unref();
    console.log(`${name} started (PID ${child.pid}).`);
  } finally { closeSync(log); }
}

async function waitFor(check, label) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${label} did not become ready. Check ${logs}`);
}

try {
  if (!existsSync(join(api, 'dist', 'main.js'))) throw new Error('Run pnpm build in api first.');
  if (!(await reachable(database.hostname, database.port || 5432))) {
    if (!['127.0.0.1', 'localhost'].includes(database.hostname)) {
      throw new Error('The configured remote database is unavailable.');
    }
    await launch(join(root, 'work', 'pg', 'pgsql', 'bin', 'postgres.exe'),
      ['-D', join(root, 'work', 'pgdata'), '-p', database.port || '5432', '-h', '127.0.0.1'], root, 'postgres');
    await waitFor(() => reachable(database.hostname, database.port || 5432), 'PostgreSQL');
  }
  if (!(await reachable('127.0.0.1', env.PORT || 3000))) {
    await launch(process.execPath, ['dist/main.js'], api, 'api');
  }
  await waitFor(async () => {
    try {
      const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(1000) });
      const body = await response.json();
      return response.ok && body.data?.status === 'ok' && body.data?.database === 'up';
    } catch { return false; }
  }, 'API');
  console.log(`Ready: ${apiUrl}/health`);
  console.log('Open this project in WeChat DevTools and compile.');
  console.log(`Logs: ${logs}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

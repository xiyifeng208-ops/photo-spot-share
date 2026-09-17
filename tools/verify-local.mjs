#!/usr/bin/env node
// 本地自检脚本：一条命令验证这套代码在当前机器上能跑到哪一层。
//
//   node tools/verify-local.mjs                  # 完整自检（缺依赖会自动装）
//   node tools/verify-local.mjs --skip-install   # 跳过 pnpm install
//   node tools/verify-local.mjs --db postgres://spot:spot@localhost:5432/spot
//   node tools/verify-local.mjs --port 3400
//
// 分层设计：
//   第一层（无需数据库）：依赖安装、类型检查、单元测试、构建、API 启动与 HTTP 行为
//   第二层（需要 PostGIS）：表结构迁移、种子数据、端到端用例（申请凭证→上传→发布→浏览→越权→软删）
//
// 脚本不依赖 PowerShell，cmd / bash 都能跑；Windows 上会自动使用 Codex 内置的 Node/pnpm。

import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'api');
const RUNTIME_DIR =
  process.env.CODEX_RUNTIME_DIR ??
  'C:\\Users\\Administrator\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const SKIP_INSTALL = flag('--skip-install');
const PORT = Number(option('--port') ?? 3210);
const JWT_SECRET = 'verify-local-secret';
const USER_ID = '11111111-1111-4111-8111-111111111111';

const results = [];
let serverProcess = null;
let databaseUrl = option('--db') ?? process.env.VERIFY_DATABASE_URL ?? '';

// ---------------------------------------------------------------- 工具函数

const c = {
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  gray: (s) => `\u001b[90m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
};

function record(name, ok, detail = '', layer = 1) {
  results.push({ name, ok, detail, layer });
  const icon = ok === true ? c.green('[PASS]') : ok === false ? c.red('[FAIL]') : c.yellow('[SKIP]');
  console.log(`${icon} ${name}${detail ? c.gray(`  ${detail}`) : ''}`);
}

function section(title) {
  console.log(`\n${c.bold(title)}`);
}

// 让子进程一定能找到 node（内置运行时不在 PATH 里）
function childEnv(extra = {}) {
  const nodeDir = dirname(process.execPath);
  return {
    ...process.env,
    PATH: `${nodeDir};${process.env.PATH ?? ''}`,
    ...extra,
  };
}

function resolvePnpm() {
  const candidates = [
    process.env.PNPM_PATH,
    join(RUNTIME_DIR, 'bin', 'fallback', 'pnpm.cmd'),
    'pnpm',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === 'pnpm') return candidate;
    if (existsSync(candidate)) return `"${candidate}"`;
  }
  return 'pnpm';
}

function run(commandLine, { env = {}, timeout = 15 * 60 * 1000 } = {}) {
  const result = spawnSync(commandLine, {
    cwd: API_DIR,
    env: childEnv(env),
    shell: true,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

function tail(text, lines = 12) {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

// 不引入 jsonwebtoken，直接手工签一个 HS256 token，避免自检依赖安装结果
function signJwt(payload, secret) {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payload);
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

function canConnect(host, port, timeoutMs = 1500) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function http(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload };
}

// ---------------------------------------------------------------- 第一层

function stepEnvironment() {
  section('[1/6] 环境');
  console.log(`   Node      ${process.version}  ${c.gray(process.execPath)}`);

  const pnpm = run(`${resolvePnpm()} --version`, { timeout: 60_000 });
  if (pnpm.code !== 0) {
    record('pnpm 可用', false, '未找到 pnpm，可执行：npm i -g pnpm');
    return false;
  }
  console.log(`   pnpm      ${pnpm.stdout.trim()}`);

  const docker = run('docker --version', { timeout: 30_000 });
  console.log(
    docker.code === 0
      ? `   Docker    ${docker.stdout.trim()}`
      : `   Docker    ${c.yellow('未安装（只影响数据库层验证）')}`,
  );
  return true;
}

function stepInstall() {
  section('[2/6] 依赖');
  const installed = existsSync(join(API_DIR, 'node_modules'));

  if (SKIP_INSTALL || installed) {
    record('依赖已就绪', true, installed ? 'node_modules 存在' : '按参数跳过安装');
    return true;
  }

  console.log(c.gray('   正在执行 pnpm install（首次约 30 秒）...'));
  const result = run(`${resolvePnpm()} install --reporter=append-only`);
  const ok = result.code === 0;
  record('pnpm install', ok, ok ? '' : tail(result.stderr || result.stdout, 6));
  return ok;
}

function stepStaticChecks() {
  section('[3/6] 静态检查');
  let ok = true;

  const typecheck = run(`${resolvePnpm()} typecheck`);
  record('TypeScript 类型检查', typecheck.code === 0, typecheck.code === 0 ? '' : tail(typecheck.stdout));
  ok = ok && typecheck.code === 0;

  const tests = run(`${resolvePnpm()} test`);
  const summary = /Tests:\s+(.*)/.exec(tests.stdout + tests.stderr)?.[1]?.trim() ?? '';
  record('单元测试', tests.code === 0, summary);
  ok = ok && tests.code === 0;

  const build = run(`${resolvePnpm()} build`);
  record('生产构建', build.code === 0, build.code === 0 ? '' : tail(build.stdout));
  ok = ok && build.code === 0;

  return ok;
}

async function probeDatabase() {
  if (!databaseUrl) databaseUrl = 'postgres://spot:spot@localhost:5432/spot';

  let host = 'localhost';
  let port = 5432;
  try {
    const parsed = new URL(databaseUrl);
    host = parsed.hostname;
    port = Number(parsed.port || 5432);
  } catch {
    // 解析失败时保留默认值，让后续连接探测给出结论
  }
  return { reachable: await canConnect(host, port), host, port };
}

async function startServer(urlForServer) {
  serverProcess = spawn(process.execPath, ['dist/main.js'], {
    cwd: API_DIR,
    env: childEnv({
      NODE_ENV: 'development',
      PORT: String(PORT),
      AUTH_DEV_MODE: 'true',
      STORAGE_DRIVER: 'local',
      PUBLIC_BASE_URL: `http://localhost:${PORT}`,
      LOCAL_STORAGE_DIR: 'var/verify-uploads',
      DATABASE_URL: urlForServer,
      JWT_SECRET,
      AMAP_KEY: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  serverProcess.stdout.on('data', (chunk) => logs.push(String(chunk)));
  serverProcess.stderr.on('data', (chunk) => logs.push(String(chunk)));

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const response = await http('GET', '/health');
      if (response.status === 200) return logs.join('');
    } catch {
      // 服务还没起来，继续等
    }
  }
  throw new Error(`API 未能在 20 秒内启动：\n${tail(logs.join(''), 15)}`);
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    serverProcess = null;
  }
}

async function stepHttpChecks(dbReachable) {
  section('[5/6] 接口行为（真实启动服务并发 HTTP 请求）');

  // 静态图片服务需要仓库里真实存在一个文件
  const fixtureDir = join(API_DIR, 'var', 'verify-uploads', 'fixture');
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'demo.txt'), 'verify-local static fixture');

  const token = signJwt(
    { sub: USER_ID, openid: 'dev:verify', iat: Math.floor(Date.now() / 1000) },
    JWT_SECRET,
  );

  const serverLog = await startServer(
    dbReachable ? databaseUrl : 'postgres://nobody@127.0.0.1:59999/none',
  );
  record('服务启动成功', true, `http://localhost:${PORT}/api/v1`);

  const expect = async (name, promise, predicate, layer = 1) => {
    try {
      const response = await promise;
      const verdict = predicate(response);
      record(name, verdict === true, verdict === true ? '' : String(verdict), layer);
    } catch (error) {
      record(name, false, error.message, layer);
    }
  };

  await expect('GET /health 返回可用状态', http('GET', '/health'), (r) => {
    if (r.status !== 200) return `期望 200，实际 ${r.status}`;
    if (!['ok', 'degraded'].includes(r.body?.data?.status)) return '响应体缺少 status';
    const db = r.body.data.database;
    if (dbReachable && db !== 'up') return `数据库应为 up，实际 ${db}`;
    return true;
  });

  await expect('本地存储驱动下静态图片可访问', http('GET', '/static/fixture/demo.txt'), (r) =>
    r.status === 200 && String(r.body).includes('verify-local') ? true : `实际 ${r.status}`,
  );

  await expect('非法 bbox 返回 400 而不是 500', http('GET', '/api/v1/spots?bbox=bad&zoom=14'), (r) =>
    r.status === 400 && r.body?.error?.code === 'BAD_REQUEST' ? true : `实际 ${r.status}`,
  );

  await expect('未登录访问 /spots/mine 返回 401', http('GET', '/api/v1/spots/mine'), (r) =>
    r.status === 401 && r.body?.error?.code === 'UNAUTHORIZED' ? true : `实际 ${r.status}`,
  );

  await expect(
    '不支持的图片类型被拒绝',
    http('POST', '/api/v1/uploads/photos/sign', { token, body: { items: [{ mime: 'image/gif' }] } }),
    (r) => (r.status === 400 ? true : `实际 ${r.status}`),
  );

  await expect(
    '超过 9 张样张被拒绝',
    http('POST', '/api/v1/uploads/photos/sign', {
      token,
      body: { items: Array.from({ length: 10 }, () => ({ mime: 'image/jpeg' })) },
    }),
    (r) => (r.status === 400 ? true : `实际 ${r.status}`),
  );

  await expect(
    '创建时标题过短被拒绝',
    http('POST', '/api/v1/spots', {
      token,
      body: { title: '短', lat: 31.2, lng: 121.5, photoKeys: ['uploads/x/a.jpg'] },
    }),
    (r) => (r.status === 400 ? true : `实际 ${r.status}`),
  );

  await expect(
    '境外坐标被拒绝',
    http('POST', '/api/v1/spots', {
      token,
      body: { title: '东京塔机位', lat: 35.65, lng: 139.74, photoKeys: ['uploads/x/a.jpg'] },
    }),
    (r) => (r.status === 400 ? true : `实际 ${r.status}`),
  );

  await expect(
    '未配置高德 Key 时逆地理编码优雅降级',
    http('GET', '/api/v1/geo/reverse?lng=121.4903&lat=31.2397', { token }),
    (r) => (r.status === 200 && r.body?.data?.source ? true : `实际 ${r.status}`),
  );

  if (dbReachable) {
    await expect('视野查询真正命中 PostGIS', http('GET', '/api/v1/spots?bbox=121.4,31.2,121.6,31.4&zoom=14'), (r) =>
      r.status === 200 && ['points', 'cluster'].includes(r.body?.data?.mode) ? true : `实际 ${r.status}`,
    );
  } else {
    record('视野查询真正命中 PostGIS', null, '数据库不可用，已跳过', 2);
  }

  if (process.env.VERIFY_SHOW_LOGS) console.log(c.gray(serverLog));
  stopServer();
  rmSync(join(API_DIR, 'var', 'verify-uploads'), { recursive: true, force: true });
}

// ---------------------------------------------------------------- 第二层

/** 迁移与种子数据必须先于接口自检执行，否则查表会 500。 */
async function stepDatabasePrepare(probe) {
  section('[4/6] 数据库准备（PostGIS）');

  if (!probe.reachable) {
    record('PostGIS 可连接', null, `${probe.host}:${probe.port} 不通，数据库层整层跳过`, 2);
    return;
  }
  record('PostGIS 可连接', true, `${probe.host}:${probe.port}`);

  const migrate = run(`${resolvePnpm()} migrate`, { env: { DATABASE_URL: databaseUrl } });
  record(
    '执行迁移（建表 + PostGIS 扩展）',
    migrate.code === 0,
    migrate.code === 0 ? '' : tail(migrate.stdout + migrate.stderr, 8),
  );

  const seed = run(`${resolvePnpm()} seed`, { env: { DATABASE_URL: databaseUrl } });
  record(
    '写入演示数据',
    seed.code === 0,
    seed.code === 0 ? '' : tail(seed.stdout + seed.stderr, 8),
  );
}

async function stepE2e(probe) {
  section('[6/6] 端到端用例');

  if (!probe.reachable) {
    record('端到端用例', null, '数据库不可用，已跳过', 2);
    return;
  }

  console.log(c.gray('   正在跑端到端用例（申请凭证→上传→发布→浏览→越权→软删）...'));
  const e2e = run(`${resolvePnpm()} test -- spots.e2e`, {
    env: { TEST_DATABASE_URL: databaseUrl },
  });
  const summary = /Tests:\s+(.*)/.exec(e2e.stdout + e2e.stderr)?.[1]?.trim() ?? '';
  record('端到端用例', e2e.code === 0, summary, 2);
}

// ---------------------------------------------------------------- 主流程

function finish() {
  const passed = results.filter((item) => item.ok === true).length;
  const failed = results.filter((item) => item.ok === false).length;
  const skipped = results.filter((item) => item.ok === null).length;

  section('结果');
  console.log(`   通过 ${c.green(passed)}   失败 ${failed ? c.red(failed) : 0}   跳过 ${skipped ? c.yellow(skipped) : 0}`);

  if (skipped > 0) {
    console.log(
      c.yellow('\n   数据库层未验证：迁移、种子数据、端到端用例都还没跑过。') +
        '\n   补齐方式（任选其一，装好后重跑本脚本会自动接上）：' +
        '\n     A. 装 Docker Desktop，然后执行：' +
        '\n        docker compose -f deploy/docker-compose.yml up -d postgres' +
        '\n     B. 装 PostgreSQL 16 + PostGIS 扩展，再用 --db 指定连接串：' +
        '\n        node tools/verify-local.mjs --db "postgres://用户:密码@localhost:5432/spot"',
    );
  }

  if (failed === 0) {
    console.log(c.green('\n   自检通过，可以继续用微信开发者工具导入 miniprogram/ 看界面。\n'));
  } else {
    console.log('');
    process.exitCode = 1;
  }
}

async function main() {
  console.log(c.bold('\n拍照机位分享 · 本地自检'));
  console.log(c.gray(`项目目录 ${ROOT}`));

  if (!stepEnvironment()) return finish();
  if (!stepInstall()) return finish();
  if (!stepStaticChecks()) return finish();

  const probe = await probeDatabase();
  await stepDatabasePrepare(probe);
  await stepHttpChecks(probe.reachable);
  await stepE2e(probe);

  return finish();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopServer();
    process.exit(1);
  });
}

main().catch((error) => {
  stopServer();
  console.error(c.red(`\n自检中断：${error.message}`));
  process.exitCode = 1;
});

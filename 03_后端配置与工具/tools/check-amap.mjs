#!/usr/bin/env node
// 检查后端的高德逆地理是否生效。
//
//   node tools/check-amap.mjs
//   node tools/check-amap.mjs --base http://10.223.96.34:3000
//   node tools/check-amap.mjs --lng 120.1438 --lat 30.2594
//
// 说明：/geo/reverse 需要登录态（防止匿名请求消耗高德配额），所以不能直接在浏览器打开。
// 脚本会先用 dev 账号换一个 token，再调用并给出结论。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

// 默认用小程序里配的第一个候选地址，和真机看到的一致
const cfg = readFileSync(resolve(ROOT, 'miniprogram/config/index.js'), 'utf8');
const firstHost = /DEV_API_URLS = \[([^\]]+)\]/
  .exec(cfg)?.[1]
  ?.split(',')[0]
  ?.trim()
  .replace(/^['"]|['"]$/g, '');

const base = argOf('--base', firstHost ? `http://${firstHost}:3000` : 'http://127.0.0.1:3000')
  .replace(/\/+$/, '')
  .replace(/\/api\/v1$/, '');
const lng = Number(argOf('--lng', '121.4903'));
const lat = Number(argOf('--lat', '31.2397'));

/** 用 process.exitCode + return 退出，避免 process.exit() 在批处理里触发 libuv 断言。 */
async function main() {
  console.log(`后端地址: ${base}\n坐标: ${lng}, ${lat}\n`);

  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);
  if (!health) {
    console.log('✘ 连不上后端。先确认后端在跑（双击 api/restart.cmd）');
    process.exitCode = 1;
    return;
  }
  console.log(`后端状态: ${health.data.status}  数据库: ${health.data.database}`);
  if (health.data.database !== 'up') {
    console.log('✘ 数据库没起，先启动 PostGIS（见 docs/LOCAL-VERIFY.md）');
    process.exitCode = 1;
    return;
  }

  const login = await fetch(`${base}/api/v1/auth/wx-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'dev:amap-check' }),
  }).then((r) => r.json()).catch(() => null);

  const token = login?.data?.token;
  if (!token) {
    console.log(`✘ 登录失败: ${JSON.stringify(login?.error ?? login)}`);
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${base}/api/v1/geo/reverse?lng=${lng}&lat=${lat}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  const raw = JSON.stringify(body);

  if (!response.ok) {
    console.log(`✘ 逆地理失败（HTTP ${response.status}）`);
    console.log(`  ${body?.error?.message ?? raw}`);
    if (/USERKEY_PLAT_NOMATCH/.test(raw)) {
      console.log('  → 去高德控制台重新添加一个 Key，服务平台必须选「Web服务」');
    } else if (/INVALID_USER_KEY/.test(raw)) {
      console.log('  → 检查 api/.env 里的 AMAP_KEY 是否复制完整');
    } else if (/SERVICE_NOT_AVAILABLE/.test(raw)) {
      console.log('  → 创建 Key 时要勾选「逆地理编码API」');
    } else {
      console.log('  → 常见错误码对照见 docs/DEPLOY.md');
    }
    process.exitCode = 1;
    return;
  }

  const data = body.data;
  console.log(`source: ${data.source}${data.configured ? '（服务端已配 Key）' : '（服务端没配 Key）'}`);
  if (data.source === 'amap' || data.source === 'cached') {
    console.log('✔ 高德逆地理已生效');
    console.log(`  地址: ${data.address ?? '(空)'}`);
    console.log(`  省/市/区: ${data.province ?? '-'} / ${data.city ?? '-'} / ${data.district ?? '-'}`);
    if (!data.city) {
      console.log('  ⚠ city 为空：直辖市由后端用 province 兜底，若这里仍为空说明后端还是旧版本，重启一次即可');
    }
  } else {
    console.log('✘ 后端没读到 AMAP_KEY：确认已填进 api/.env 并重启过后端');
    process.exitCode = 1;
  }
}

await main();

#!/usr/bin/env node
// 上线前的小程序结构自检：合规入口是否齐全、模板与页面方法是否对得上。
//
//   node tools/check-launch-ui.mjs
//
// 检查项：
//   1. 协议页已注册在 app.json 里
//   2. 详情页有举报入口（且作者本人看不到）、页面方法存在
//   3. 创建页有"同意协议"门槛与协议链接
//   4. 我的页有协议入口、能显示审核中状态
//   5. 所有页面的 WXML 事件绑定都在 JS 里有对应方法
//   6. WXML 表达式里没有调用数组方法（模板不支持，会让高亮/判断失效）
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MP = join(ROOT, 'miniprogram');

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  ${detail}` : ''}`);
};

const read = (p) => readFileSync(join(MP, p), 'utf8');
const app = JSON.parse(read('app.json'));

console.log('1. 协议页注册');
check('app.json 里已注册 pages/legal/index', app.pages.includes('pages/legal/index'));

console.log('\n2. 举报入口（详情页）');
const detailWxml = read('pages/spot/detail.wxml');
const detailJs = read('pages/spot/detail.js');
check('详情页有举报入口', /onReportTap/.test(detailWxml));
check('举报入口只对非作者显示', /wx:if="\{\{!spot\.isMine\}\}"[\s\S]{0,80}onReportTap/.test(detailWxml));
check('页面实现了 onReportTap', /onReportTap\s*\(/.test(detailJs));
check('举报会调用后端接口', /\/spots\/\$\{[^}]+\}\/report/.test(detailJs));

console.log('\n3. 发布前的协议门槛（创建页）');
const createWxml = read('pages/spot/create.wxml');
const createJs = read('pages/spot/create.js');
check('创建页有同意协议勾选', /onToggleAgree/.test(createWxml) && /agreed/.test(createWxml));
check('未同意时 onSubmit 会拦截', /!this\.data\.agreed/.test(createJs));
check(
  '创建页可跳转协议页',
  /onOpenLegal/.test(createWxml) && /pages\/legal\/index\?type=/.test(createJs)
);
check('编辑模式不强制勾选', /!this\.data\.isEdit && !this\.data\.agreed/.test(createJs));

console.log('\n4. 我的页');
const mineWxml = read('pages/mine/index.wxml');
const mineJs = read('pages/mine/index.js');
check('我的页有协议入口', /onOpenLegal/.test(mineWxml) && /onOpenLegal\s*\(/.test(mineJs));
check(
  '我的页显示审核中状态',
  /statusText/.test(mineWxml) && /pending' \? '审核中'/.test(mineJs.replace(/\s+/g, ' '))
);

console.log('\n5. WXML 绑定与页面方法一致性');
function walkPages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkPages(full));
    else if (name.endsWith('.wxml')) out.push(full);
  }
  return out;
}
let missing = 0;
for (const wxml of walkPages(join(MP, 'pages'))) {
  const jsPath = wxml.replace(/\.wxml$/, '.js');
  let js;
  try {
    js = readFileSync(jsPath, 'utf8');
  } catch {
    continue;
  }
  const handlers = [
    ...new Set(
      [...readFileSync(wxml, 'utf8').matchAll(/bind(?:tap|input|change|regionchange|markertap|updated|error)="([^"]+)"/g)].map(
        (m) => m[1],
      ),
    ),
  ];
  const lost = handlers.filter((h) => !new RegExp(`\\b${h}\\s*\\(`).test(js));
  if (lost.length) {
    missing += lost.length;
    console.log(`     ${relative(MP, wxml)} 缺少: ${lost.join(', ')}`);
  }
}
check('所有 WXML 事件绑定都有对应方法', missing === 0, missing ? `${missing} 个缺失` : '');

console.log('\n6. WXML 表达式合法性');
let badExpr = 0;
for (const wxml of walkPages(join(MP, 'pages'))) {
  vp: {
    readFileSync(wxml, 'utf8')
      .split('\n')
      .forEach((line) => {
        for (const expr of line.match(/\{\{[^}]*\}\}/g) ?? []) {
          if (/\.(indexOf|includes|filter|map|join|find|slice|split)\(/.test(expr)) {
            badExpr += 1;
            console.log(`     ${relative(MP, wxml)} 模板里调用了数组方法: ${expr.trim()}`);
          }
        }
      });
  }
}
check('模板里没有调用数组方法', badExpr === 0, badExpr ? `${badExpr} 处` : '');

const passed = results.filter(Boolean).length;
console.log(`\n结果：${passed}/${results.length} 项通过`);
process.exitCode = passed === results.length ? 0 : 1;

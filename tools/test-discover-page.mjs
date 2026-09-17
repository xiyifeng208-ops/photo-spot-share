#!/usr/bin/env node
// 发现页（现在是默认首页）的离线回归测试：
//   A. 定位很慢时，列表必须先渲染出来（不能等定位）
//   B. 定位回来后再自动切到所在城市并刷新
//   C. 用户在定位回来之前手动切过城市，就不许被自动覆盖
//
//   node tools/test-discover-page.mjs
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MINIPROGRAM = resolve(ROOT, 'miniprogram');
const require_ = createRequire(resolve(MINIPROGRAM, 'app.js'));

const results = [];
function check(label, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  ${detail}` : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ONE_SPOT = {
  id: 's1',
  title: '外滩机位',
  lat: 31.23,
  lng: 121.49,
  city: '上海市',
  district: '黄浦区',
  difficulty: 1,
  difficultyLabel: '轻松到达',
  headingLabel: '朝东北',
  bestTimeLabels: ['日落'],
  coverUrl: null,
  distanceMeters: null,
  author: {},
  createdAt: '2026-09-16T05:00:00.000Z'
};

/** locationDelayMs 模拟定位耗时；0 表示直接失败（拿不到定位）。 */
function makeWx({ locationDelayMs = 800, city = '上海市', failHost = '' } = {}) {
  const requests = [];
  return {
    __requests: requests,
    request: (options) => {
      requests.push(options.url);
      // 模拟"公司 Wi-Fi 连不通"：命中指定 host 的请求直接失败
      if (failHost && options.url.includes(failHost)) {
        options.fail({ errMsg: 'request:fail timeout' });
        return;
      }
      if (options.url.includes('/spots/feed')) {
        options.success({
          statusCode: 200,
          data: { data: { items: [ONE_SPOT], nextCursor: '' } }
        });
        return;
      }
      if (options.url.includes('/geo/reverse')) {
        options.success({
          statusCode: 200,
          data: { data: { province: '上海市', city, district: '黄浦区', address: '中山东一路', source: 'amap', configured: true } }
        });
        return;
      }
      // 登录
      options.success({ statusCode: 201, data: { data: { token: 't', user: { id: 'u1' } } } });
    },
    getLocation: (options) => {
      if (!locationDelayMs) {
        options.fail && options.fail(new Error('denied'));
        return;
      }
      setTimeout(() => options.success({ latitude: 31.23, longitude: 121.47 }), locationDelayMs);
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    stopPullDownRefresh: () => {},
    switchTab: () => {},
    navigateTo: () => {},
  };
}

function loadDiscoverPage() {
  let captured = null;
  globalThis.Page = (obj) => {
    captured = obj;
  };
  globalThis.getApp = () => ({ globalData: {} });

  const entry = require_.resolve('./pages/discover/index.js');
  delete require_.cache[entry];
  require_('./pages/discover/index.js');

  const instance = { ...captured, data: { ...captured.data } };
  instance.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return instance;
}

const feedUrls = (wx) => wx.__requests.filter((u) => u.includes('/spots/feed'));

// ---------- A / B：定位慢，列表先出，随后自动切城市 ----------
console.log('场景 A/B：定位耗时 800ms');
globalThis.wx = makeWx({ locationDelayMs: 800 });
const pageA = loadDiscoverPage();
pageA.onLoad();

const immediateFeeds = feedUrls(globalThis.wx);
check(
  'onLoad 同步阶段就已经发出列表请求（没等定位）',
  immediateFeeds.length === 1,
  immediateFeeds[0] ? immediateFeeds[0].replace(/^.*\/api\/v1/, '') : '(没有请求)'
);
check('第一屏不带城市筛选（全国列表）', immediateFeeds[0] && !immediateFeeds[0].includes('city='));

await wait(1500);

const afterFeeds = feedUrls(globalThis.wx);
check('定位回来后自动按城市又拉了一次', afterFeeds.length >= 2, `共 ${afterFeeds.length} 次 feed 请求`);
check(
  '第二次带上了定位城市',
  afterFeeds.at(-1).includes(`city=${encodeURIComponent('上海市')}`),
  afterFeeds.at(-1).replace(/^.*\/api\/v1/, '')
);
check('城市筛选状态已生效', pageA.data.city === '上海市' && pageA.data.located === true, `city=${pageA.data.city}`);

// ---------- C：用户手动切过城市 ----------
console.log('\n场景 C：用户在定位回来之前手动切了城市');
globalThis.wx = makeWx({ locationDelayMs: 800 });
const pageC = loadDiscoverPage();
pageC.onLoad();
pageC.onToggleCity(); // 用户主动操作
await wait(1500);

const feedsC = feedUrls(globalThis.wx);
check(
  '不再被定位城市自动覆盖',
  feedsC.every((u) => !u.includes('city=')),
  `feed 请求：${feedsC.length} 次，带 city 的 ${feedsC.filter((u) => u.includes('city=')).length} 次`
);
check('city 保持为空', pageC.data.city === '');

// ---------- D：定位直接失败 ----------
console.log('\n场景 D：定位失败');
globalThis.wx = makeWx({ locationDelayMs: 0 });
const pageD = loadDiscoverPage();
pageD.onLoad();
await wait(600);
check('列表照常有数据', pageD.data.spots.length === 1, `spots=${pageD.data.spots.length}`);
check('不会卡在 loading', pageD.data.loading === false);

// ---------- E：第一个后端地址不通，自动换候选地址 ----------
console.log('\n场景 E：首选地址不通，自动切换候选地址');
globalThis.wx = makeWx({ locationDelayMs: 0, failHost: '10.163.213.42' });
const pageE = loadDiscoverPage();
pageE.onLoad();
await wait(800);

const feedsE = feedUrls(globalThis.wx);
check('首选地址确实失败过', feedsE.some((u) => u.includes('10.163.213.42')));
check(
  '自动换到备选地址并拿到数据',
  feedsE.some((u) => u.includes('192.168.137.1')) && pageE.data.spots.length === 1,
  `feed 请求 host：${feedsE.map((u) => u.match(/\/\/([^:]+)/)[1]).join(' → ')}`
);

const passed = results.filter(Boolean).length;
console.log(`\n结果：${passed}/${results.length} 项通过`);
process.exit(passed === results.length ? 0 : 1);

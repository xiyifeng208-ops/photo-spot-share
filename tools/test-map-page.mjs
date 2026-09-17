#!/usr/bin/env node
// 地图页的离线回归测试：用桩件替换 wx API，直接跑 miniprogram/pages/map/index.js 的真实代码。
//
//   node tools/test-map-page.mjs
//
// 覆盖以下场景：
//   A. 地图组件永远不回调（开发者工具里灰白卡死）→ 必须有超时兜底，不能一直 loading
//   B. 地图正常 → 点位正常渲染
//   C. 地图 2 秒后才渲染好 → 自动恢复，不需要用户操作
//   D. 地图正常但接口失败 → 区分失败原因，提示后端可能没启动
//   E. 地图 5 秒后才就绪（落在宽限期内）→ 不能误报失败，最终要正常渲染
//   F. 从创建页返回（页面隐藏导致旧 MapContext 失效）→ 重建 context，不能误报失败
//   G. 用户缩放地图 → 不能把 scale 写回 map 属性（会把地图搞白），但查询要用新级别
//   H. 点「重新进入页面」→ 走 wx.reLaunch 整页重建，而不是卸载/挂载地图组件
//   I. getRegion 间歇性丢回调（地图 updated 正常）→ 重试后要能自愈
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MINIPROGRAM = resolve(ROOT, 'miniprogram');
const require_ = createRequire(resolve(MINIPROGRAM, 'app.js'));

const ONE_SPOT = {
  mode: 'points',
  items: [
    {
      id: 's1',
      title: '外滩机位',
      lat: 31.23,
      lng: 121.49,
      city: '上海市',
      difficulty: 1,
      difficultyLabel: '轻松到达',
      headingLabel: '朝东北',
      bestTimeLabels: ['日落'],
      coverUrl: null,
      author: {},
      createdAt: '2026-09-15T10:00:00.000Z',
    },
  ],
  clusters: [],
  truncated: false,
};

const CLUSTERS = {
  mode: 'cluster',
  items: [],
  clusters: [{ city: '上海市', count: 3, lat: 31.2, lng: 121.5 }],
  truncated: false,
};

function makeWx({ mapCallbackStyle, spotsResponse, lateMs = 0, requestFails = false, regionFailTimes = 0 }) {
  const t0 = Date.now();
  let epoch = 0; // 页面隐藏会让已创建的 MapContext 失效，用 epoch 模拟
  let regionFailuresLeft = regionFailTimes; // 前 N 次 getRegion 丢回调（原生组件重绘期间）
  const requests = [];
  const relaunches = [];
  return {
    __requests: requests,
    __relaunches: relaunches,
    // 模拟一次 onHide：此前创建的 context 全部失效
    killContexts() {
      epoch += 1;
    },
    createMapContext: () => {
      const myEpoch = epoch;
      return {
        getRegion: (options) => {
          if (myEpoch !== epoch) return; // 失效的 context：既不 success 也不 fail
          if (mapCallbackStyle === 'never') return; // 地图没渲染：success/fail 都不来
          if (regionFailuresLeft > 0) {
            regionFailuresLeft -= 1;
            return; // 这一帧丢回调
          }
          if (mapCallbackStyle === 'late' && Date.now() - t0 < lateMs) return;
          options.success({
            southwest: { longitude: 121.4, latitude: 31.2 },
            northeast: { longitude: 121.6, latitude: 31.4 },
          });
        },
        getCenterLocation: (options) => options.fail && options.fail(new Error('no map')),
      };
    },
    getLocation: (options) => {
      if (mapCallbackStyle === 'never') return;
      options.success({ latitude: 31.23, longitude: 121.47 });
    },
    request: (options) => {
      requests.push(options.url);
      if (requestFails) options.fail({ errMsg: 'request:fail timeout' });
      else options.success({ statusCode: 200, data: { data: spotsResponse } });
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    switchTab: () => {},
    reLaunch: (options) => relaunches.push(options.url),
    login: (options) => options.fail && options.fail(new Error('no login')),
  };
}

function loadMapPage() {
  let captured = null;
  globalThis.Page = (obj) => {
    captured = obj;
  };
  globalThis.getApp = () => ({ globalData: {} });

  const entry = require_.resolve('./pages/map/index.js');
  delete require_.cache[entry];
  require_('./pages/map/index.js');

  const instance = { ...captured, data: { ...captured.data } };
  instance.__patches = [];
  instance.setData = function setData(patch) {
    instance.__patches.push(patch);
    Object.assign(this.data, patch);
  };
  return instance;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(label, ok, detail) {
  results.push(ok);
  console.log(`  ${ok ? '[PASS]' : '[FAIL]'} ${label}${detail ? `  ${detail}` : ''}`);
}

// ---------- A：地图永远不回调 ----------
console.log('场景 A：地图组件永远不回调（复现灰白卡死）');
globalThis.wx = makeWx({ mapCallbackStyle: 'never', spotsResponse: CLUSTERS });
const pageA = loadMapPage();
pageA.onLoad();
pageA.mapReadyGraceMs = 1500; // 测试里缩短宽限期，生产环境是 8 秒
pageA.regionTimeoutMs = 1000; // 测试里缩短视野查询超时
await wait(4000);
check('loading 已复位（不再永远"加载中"）', pageA.data.loading === false, `loading=${pageA.data.loading}`);
check('进入降级面板', pageA.data.mapFailed === true && pageA.data.failReason === 'map', `tip=${pageA.data.tip}`);
check('给出全国机位汇总', Boolean(pageA.data.fallbackSummary), pageA.data.fallbackSummary);

// ---------- B：地图正常 ----------
console.log('\n场景 B：地图正常');
globalThis.wx = makeWx({ mapCallbackStyle: 'normal', spotsResponse: ONE_SPOT });
const pageB = loadMapPage();
pageB.onLoad();
pageB.onMapReady();
await wait(2500);
check('点位已渲染', pageB.data.markers.length === 1, `markers=${pageB.data.markers.length}`);
check('无失败态', pageB.data.mapFailed === false && pageB.data.loading === false);

// ---------- C：地图延迟 2 秒就绪 ----------
console.log('\n场景 C：地图 2 秒后才就绪');
globalThis.wx = makeWx({ mapCallbackStyle: 'late', lateMs: 2000, spotsResponse: ONE_SPOT });
const pageC = loadMapPage();
pageC.onLoad();
setTimeout(() => pageC.onMapReady(), 2000);
await wait(5000);
check('自动恢复且无需用户操作', pageC.data.markers.length === 1 && pageC.data.mapFailed === false, `markers=${pageC.data.markers.length}`);

// ---------- D：地图正常但接口失败 ----------
console.log('\n场景 D：地图正常、接口失败');
globalThis.wx = makeWx({ mapCallbackStyle: 'normal', requestFails: true, spotsResponse: {} });
const pageD = loadMapPage();
pageD.onLoad();
pageD.onMapReady();
await wait(4000);
check('区分出是接口失败', pageD.data.mapFailed === true && pageD.data.failReason === 'data');
check('提示后端可能没启动', /后端服务/.test(pageD.data.fallbackDesc), pageD.data.fallbackDesc);

// ---------- E：地图 5 秒后就绪（落在 8 秒宽限期内）----------
console.log('\n场景 E：地图 5 秒后才就绪（宽限期内不能误报失败）');
globalThis.wx = makeWx({ mapCallbackStyle: 'late', lateMs: 5000, spotsResponse: ONE_SPOT });
const pageE = loadMapPage();
pageE.onLoad();
setTimeout(() => pageE.onMapReady(), 5000);
await wait(3800);
check(
  '宽限期内不误报失败',
  pageE.data.mapFailed === false,
  `mapFailed=${pageE.data.mapFailed} tip=${pageE.data.tip}`
);
await wait(3500);
check(
  '地图就绪后正常渲染点位',
  pageE.data.markers.length === 1 && pageE.data.mapFailed === false,
  `markers=${pageE.data.markers.length}`
);
check('输出调试信息', /updated×/.test(pageE.data.debugLine), pageE.data.debugLine);

// ---------- F：从创建页返回（旧 MapContext 失效）----------
console.log('\n场景 F：跳转创建页后返回地图');
globalThis.wx = makeWx({ mapCallbackStyle: 'normal', spotsResponse: ONE_SPOT });
const pageF = loadMapPage();
pageF.onLoad();
pageF.onShow(); // 首次 onShow，不算返回
pageF.onMapReady();
await wait(2000);
check('返回前点位已渲染', pageF.data.markers.length === 1, `markers=${pageF.data.markers.length}`);

globalThis.wx.killContexts(); // 跳转创建页：页面隐藏，旧 context 失效
pageF.onShow(); // 返回地图页
await wait(4000);
check(
  '返回时不整页重载（避免打断用户）',
  globalThis.wx.__relaunches.length === 0,
  `reLaunch ${globalThis.wx.__relaunches.length} 次`
);
check('返回后不误报失败', pageF.data.mapFailed === false, `mapFailed=${pageF.data.mapFailed} tip=${pageF.data.tip}`);
check('返回后点位仍在', pageF.data.markers.length === 1, `markers=${pageF.data.markers.length}`);

// ---------- G：缩放时不能把 scale 写回地图 ----------
console.log('\n场景 G：用户缩放地图');
globalThis.wx = makeWx({ mapCallbackStyle: 'normal', spotsResponse: ONE_SPOT });
const pageG = loadMapPage();
pageG.onLoad();
pageG.onShow();
pageG.onMapReady();
await wait(1500);

const patchCountBefore = pageG.__patches.length;
const scaleBefore = pageG.data.scale;
pageG.onRegionChange({ type: 'end', causedBy: 'scale', detail: { scale: 16 } });
await wait(1500);

const zoomPatches = pageG.__patches.slice(patchCountBefore);
const scaleWrites = zoomPatches.filter((p) => 'scale' in p).length;
check(
  '没把用户缩放写回 map 的 scale 属性',
  scaleWrites === 0 && pageG.data.scale === scaleBefore,
  `缩放后写回 ${scaleWrites} 次，scale=${pageG.data.scale}（原 ${scaleBefore}）`
);
const lastUrl = globalThis.wx.__requests.at(-1) || '';
check('查询用的是用户实际缩放级别', /zoom=16/.test(lastUrl), lastUrl.replace(/^.*\/spots\?/, '/spots?'));
check('缩放后点位仍正常', pageG.data.markers.length === 1, `markers=${pageG.data.markers.length}`);

// ---------- H：点「重新进入页面」走整页重建 ----------
console.log('\n场景 H：点击「重新进入页面」');
globalThis.wx = makeWx({ mapCallbackStyle: 'normal', spotsResponse: ONE_SPOT });
const pageH = loadMapPage();
pageH.onLoad();
pageH.onShow();
pageH.onMapReady();
await wait(1500);

pageH.setData({ mapFailed: true, failReason: 'map' }); // 模拟面板已弹出
pageH.onRetryTap();
await wait(300);

check(
  '触发整页重建（wx.reLaunch 到地图页）',
  globalThis.wx.__relaunches.at(-1) === '/pages/map/index',
  globalThis.wx.__relaunches.join(', ') || '(未触发)'
);
check('点完立刻关掉面板', pageH.data.mapFailed === false);

// ---------- I：地图活着，但 getRegion 间歇性丢回调（用户线上遇到的场景）----------
console.log('\n场景 I：getRegion 间歇性丢回调（updated 正常）');
globalThis.wx = makeWx({ mapCallbackStyle: 'normal', spotsResponse: ONE_SPOT, regionFailTimes: 2 });
const pageI = loadMapPage();
pageI.onLoad();
pageI.regionTimeoutMs = 1000;
pageI.onShow();
pageI.onMapReady();
await wait(5000);
check(
  '重试后正常拿到视野并渲染点位',
  pageI.data.markers.length === 1 && pageI.data.mapFailed === false,
  `markers=${pageI.data.markers.length} mapFailed=${pageI.data.mapFailed} tip=${pageI.data.tip}`
);

const passed = results.filter(Boolean).length;
console.log(`\n结果：${passed}/${results.length} 项通过`);
process.exit(passed === results.length ? 0 : 1);

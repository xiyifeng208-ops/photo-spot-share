#!/usr/bin/env node
// 创建机位页的离线回归测试，重点覆盖"服务端没配高德 Key"时的降级路径：
//   1. 选点拿不到地址时，页面要提示手动填写（而不是假装下一步能写）
//   2. 手动填写的地址必须真的进到 POST /spots 的 geo.address 里
//
//   node tools/test-create-page.mjs
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

function makeWx({ reverseConfigured, reverseErrorMessage }) {
  const requests = [];
  return {
    __requests: requests,
    createMapContext: () => ({
      getCenterLocation: (options) => options.fail && options.fail(new Error('no map')),
      getRegion: (options) => options.fail && options.fail(new Error('no map'))
    }),
    // 定位直接失败：跳过 6 秒高精度等待
    getLocation: (options) => options.fail && options.fail(new Error('denied')),
    request: (options) => {
      requests.push({ url: options.url, method: options.method, data: options.data });
      if (options.url.includes('/geo/reverse')) {
        if (reverseErrorMessage) {
          options.success({
            statusCode: 502,
            data: { error: { code: 'GEO_UNAVAILABLE', message: reverseErrorMessage } }
          });
          return;
        }
        options.success({
          statusCode: 200,
          data: {
            data: reverseConfigured
              ? { province: '上海市', city: '上海市', district: '黄浦区', address: '中山东一路', source: 'amap', configured: true }
              : { province: null, city: null, district: null, address: null, source: 'unavailable', configured: false }
          }
        });
        return;
      }
      options.success({ statusCode: 201, data: { data: { id: 'spot-new' } } });
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
    showToast: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    setNavigationBarTitle: () => {},
    redirectTo: () => {},
    navigateBack: () => {},
  };
}

function loadCreatePage() {
  let captured = null;
  globalThis.Page = (obj) => {
    captured = obj;
  };
  globalThis.getApp = () => ({ globalData: {} });

  const entry = require_.resolve('./pages/spot/create.js');
  delete require_.cache[entry];
  require_('./pages/spot/create.js');

  const instance = { ...captured, data: { ...captured.data } };
  instance.__patches = [];
  instance.setData = function setData(patch) {
    instance.__patches.push(patch);
    Object.assign(this.data, patch);
  };
  return instance;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 场景 A：服务端没配高德 Key ----------
console.log('场景 A：未接入逆地理编码（没配 AMAP_KEY）');
globalThis.wx = makeWx({ reverseConfigured: false });
const pageA = loadCreatePage();
pageA.onLoad({});

pageA.viewScale = 14;
pageA.setData({
  latitude: 31.2397,
  longitude: 121.4903,
  addressText: '未接入逆地理编码（服务端没配高德 Key），请在下方手动填写地址',
  addressInput: '上海市黄浦区中山东一路 27 号',
  title: '外滩测试机位',
  photos: [{ key: 'uploads/user/20260915/a.jpg', url: 'http://localhost:3000/static/a.jpg' }]
});

try {
  await pageA.onSubmit();
} catch (error) {
  console.log('  onSubmit 抛错：', error && error.message);
}
await wait(200);

const createA = globalThis.wx.__requests.find(
  (r) => r.url.endsWith('/spots') && r.method === 'POST'
);
check('真的发出了创建请求', Boolean(createA), createA ? createA.url : '没发出去');
check(
  '手动填写的地址进入了 geo.address',
  createA && createA.data.geo && createA.data.geo.address === '上海市黄浦区中山东一路 27 号',
  JSON.stringify(createA && createA.data.geo)
);
check('没有高德时 city 保持为空（不编造）', createA && !createA.data.geo.city, `city=${createA && createA.data.geo.city}`);
check('照片 key 正确带上', createA && createA.data.photoKeys.length === 1);

// ---------- 场景 B：配了高德，地址自动填充 ----------
console.log('\n场景 B：已接入逆地理编码');
globalThis.wx = makeWx({ reverseConfigured: true });
const pageB = loadCreatePage();
pageB.onLoad({});
pageB.mapContext = { getCenterLocation: (options) => options.success({ latitude: 31.2397, longitude: 121.4903 }) };
await pageB.reverseGeocode();
await wait(50);

check('地址被自动填进输入框', pageB.data.addressInput === '中山东一路', `addressInput=${pageB.data.addressInput}`);
check('同时保留了省市区的逆地理结果', pageB.data.geoMeta && pageB.data.geoMeta.city === '上海市');

// ---------- 场景 C：多选选项的选中态 ----------
// 回归：WXML 表达式不支持调用数组方法，之前用 bestTimes.indexOf(...) 判断高亮，
// 结果点了没有任何反馈，看起来像"选不了"。选中态必须在 JS 里算好。
console.log('\n场景 C：多选（推荐时段 / 季节）的选中态');
globalThis.wx = makeWx({ reverseConfigured: false });
const pageC = loadCreatePage();
pageC.onLoad({});

check(
  '初始时所有时段都未选中',
  pageC.data.bestTimeOptions.every((o) => !o.selected),
  `options=${pageC.data.bestTimeOptions.length}`
);

pageC.onToggleMulti({ currentTarget: { dataset: { field: 'bestTimes', value: 'sunset' } } });
check('点击后数据里记录了该时段', pageC.data.bestTimes.indexOf('sunset') > -1, JSON.stringify(pageC.data.bestTimes));
check(
  '对应选项被标记为选中（模板靠这个高亮）',
  pageC.data.bestTimeOptions.find((o) => o.value === 'sunset').selected === true
);
check(
  '其他选项不受影响',
  pageC.data.bestTimeOptions.filter((o) => o.selected).length === 1
);

pageC.onToggleMulti({ currentTarget: { dataset: { field: 'bestTimes', value: 'sunset' } } });
check(
  '再点一次取消选中',
  pageC.data.bestTimes.length === 0 && pageC.data.bestTimeOptions.every((o) => !o.selected)
);

pageC.onToggleMulti({ currentTarget: { dataset: { field: 'bestSeasons', value: 'autumn' } } });
check(
  '季节的多选同样生效',
  pageC.data.seasonOptions.find((o) => o.value === 'autumn').selected === true
);

// ---------- 场景 D：配了 Key 但调用失败，必须显示真实原因 ----------
// 回归：早前把失败一律吞成"没配 Key"，Key 类型选错时会把人引向错误的排查方向
console.log('\n场景 D：地址服务调用失败（例如 Key 类型选错）');
globalThis.wx = makeWx({
  reverseConfigured: true,
  reverseErrorMessage:
    '地址服务异常（USERKEY_PLAT_NOMATCH）：Key 与调用平台不匹配，创建 Key 时服务平台必须选「Web服务」'
});
const pageD = loadCreatePage();
pageD.onLoad({});
pageD.mapContext = {
  getCenterLocation: (options) => options.success({ latitude: 31.2397, longitude: 121.4903 })
};
await pageD.reverseGeocode();
await wait(50);

check(
  '提示里带上了后端返回的真实原因',
  /USERKEY_PLAT_NOMATCH/.test(pageD.data.addressText) && /Web服务/.test(pageD.data.addressText),
  pageD.data.addressText.slice(0, 70)
);
check('不再谎称"没配高德 Key"', !/没配高德 Key/.test(pageD.data.addressText));
check('保留手动填写作为兜底', /手动填写/.test(pageD.data.addressText));
check('不再提示"服务端未配置"', pageD.data.geoConfigured === true);

const passed = results.filter(Boolean).length;
console.log(`\n结果：${passed}/${results.length} 项通过`);
process.exit(passed === results.length ? 0 : 1);

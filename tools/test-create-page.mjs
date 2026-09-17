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

function makeWx({ reverseConfigured }) {
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

const passed = results.filter(Boolean).length;
console.log(`\n结果：${passed}/${results.length} 项通过`);
process.exit(passed === results.length ? 0 : 1);

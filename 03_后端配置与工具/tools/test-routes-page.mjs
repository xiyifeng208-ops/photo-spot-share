// Offline regression: mock all HTTP and navigation; never writes to a real API/database.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);
const format = require_('../miniprogram/utils/format.js');
const cities = require_('../miniprogram/data/cities.js');
const tick = () => new Promise(done => setTimeout(done, 0));
const event = id => ({ currentTarget: { dataset: { id } } });
let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`[PASS] ${name}`); }
const route = (id = 'shanghai-demo') => ({
  id, title: '上海摄影演示路线', city: '上海市', province: '上海市', summary: '三个现有机位的演示编排',
  isDemo: true, disclaimer: '演示编排，未经实地验证。', theme: '城市摄影', updatedAt: '2026-09-18',
  coverUrl: 'https://invalid/cover.jpg', stopCount: 2, totalStopCount: 3, unavailableCount: 1,
  preparation: ['请自行核实开放和交通情况'], stops: [1, 3].map(order => ({
    order, suggestedTime: `建议时段 ${order}`, note: `提示 ${order}`,
    spot: { id: `spot-${order}`, title: `机位 ${order}`, city: '上海市', coverUrl: 'https://invalid/spot.jpg',
      headingLabel: '朝北', bestTimeLabels: ['日落'], difficultyLabel: '轻松到达' }
  }))
});

function harness(file) {
  const calls = [], navigation = [];
  let page, refreshStops = 0, patches = 0;
  const mocks = {
    '../../utils/request': { request: options => new Promise((resolve_, reject) => {
      calls.push({ ...options, resolve: resolve_, reject });
    }) },
    '../../utils/format': format, '../../utils/auth': {}, '../../utils/geo': {}, '../../data/cities': cities
  };
  vm.runInNewContext(readFileSync(resolve(root, file), 'utf8'), {
    require: key => mocks[key], Page: definition => { page = definition; }, setTimeout, clearTimeout,
    wx: {
      navigateTo: value => navigation.push({ method: 'navigateTo', url: value.url }),
      redirectTo: value => navigation.push({ method: 'redirectTo', url: value.url }),
      switchTab: value => navigation.push({ method: 'switchTab', url: value.url }),
      stopPullDownRefresh: () => { refreshStops++; }
    }
  });
  page.setData = patch => { patches++; Object.assign(page.data, patch); };
  return { page, calls, navigation, refreshStops: () => refreshStops, patches: () => patches };
}

const LIST = 'miniprogram/pages/routes/index.js';
const DETAIL = 'miniprogram/pages/routes/detail.js';

{
  const h = harness(LIST), { page, calls, navigation } = h;
  page.onLoad(); page.onShow();
  check('路线列表首次打开只请求一次，无定位或登录依赖', calls.length === 1 && calls[0].url === '/routes' && calls[0].skipAuth);
  check('列表请求期间单独显示加载状态', page.data.loading && !page.data.error && page.data.routes.length === 0);
  calls[0].resolve({ items: [route()] }); await tick();
  check('列表正常显示路线、演示声明和不可用站点数量', page.data.routes[0].isDemo && page.data.routes[0].unavailableCount === 1 && !page.data.loading);
  page.onRouteTap(event('shanghai-demo'));
  check('点击路线进入独立详情', navigation.at(-1).url === '/pages/routes/detail?id=shanghai-demo');
  const before = navigation.length; page.onRouteTap(event('not-present'));
  check('不导航到当前列表不存在的路线', navigation.length === before);
  page.onCoverError(event('shanghai-demo'));
  check('路线封面失败保留卡片和错误占位状态', page.data.routes[0].coverFailed && !page.data.routes[0].coverUrl);
  page.onShow();
  check('从详情返回重新获取公开站点状态，不沿用过期列表', calls.length === 2 && page.data.routes.length === 0);
  calls.at(-1).resolve({ items: [] }); await tick();
  check('没有可用路线时正常空状态，不是请求失败', !page.data.error && !page.data.loading && page.data.routes.length === 0);
  page.onGoDiscover();
  check('空列表提供返回发现入口', navigation.at(-1).method === 'switchTab' && navigation.at(-1).url === '/pages/discover/index');
  const pull = page.onPullDownRefresh(); calls.at(-1).resolve({ items: [route('restored')] }); await pull;
  check('下拉刷新恢复可用路线并停止刷新动画', page.data.routes[0].id === 'restored' && h.refreshStops() === 3);
}

{
  const { page, calls } = harness(LIST);
  page.onLoad(); const first = calls[0]; page.onRetry(); const second = calls[1];
  second.resolve({ items: [route('new')] }); await tick(); first.resolve({ items: [route('old')] }); await tick();
  check('旧列表成功响应不能覆盖较新的路线列表', page.data.routes[0].id === 'new');
  const oldRequest = page.reload(), older = calls.at(-1);
  const newRequest = page.reload(), newer = calls.at(-1);
  newer.resolve({ items: [route('latest')] }); await newRequest;
  older.reject(new Error('旧网络错误')); await oldRequest;
  check('旧列表失败不覆盖新内容或显示错误', page.data.routes[0].id === 'latest' && !page.data.error);
  const failure = page.onPullDownRefresh(); calls.at(-1).reject(new Error('网络不可用')); await failure;
  check('列表网络失败显示错误而非空结果', page.data.error === '网络不可用' && !page.data.loading && page.data.routes.length === 0);
  const retry = page.onRetry(); calls.at(-1).resolve({ items: [route()] }); await retry;
  check('列表失败可重试恢复', !page.data.error && page.data.routes.length === 1);
}

{
  const h = harness(LIST); h.page.onLoad(); h.page.onUnload(); const count = h.patches();
  h.calls[0].resolve({ items: [route()] }); await tick();
  check('列表离开后的响应不再更新页面', h.patches() === count);
}

{
  const h = harness(DETAIL), { page, calls, navigation } = h;
  page.onLoad({ id: 'shanghai-demo' }); page.onShow();
  check('路线详情首次匿名读取，不请求机位详情或增加浏览量', calls.length === 1 && calls[0].url === '/routes/shanghai-demo' && calls[0].skipAuth);
  calls[0].resolve(route()); await tick();
  check('详情保留有缺站的原始站序与提示', JSON.stringify(page.data.route.stops.map(stop => stop.order)) === '[1,3]' && page.data.route.unavailableCount === 1);
  check('路线机位复用既有拍摄标签展示', page.data.route.stops[0].spot.tagList.join('/') === '朝北/日落/轻松到达');
  check('演示声明和出发准备提示保留', page.data.route.disclaimer.includes('未经实地验证') && page.data.route.preparation.length === 1);
  page.onSpotTap(event('spot-3'));
  check('路线站点进入原有作品详情，复用收藏与导航', navigation.at(-1).url === '/pages/spot/detail?id=spot-3');
  const before = navigation.length; page.onSpotTap(event('hidden-spot'));
  check('已下架和不存在站点不能从路线跳转', navigation.length === before);
  page.onCoverError(event('spot-1'));
  check('单个站点封面失败不影响其他站点图片', page.data.route.stops[0].spot.coverFailed && !page.data.route.stops[0].spot.coverUrl && !!page.data.route.stops[1].spot.coverUrl);
  page.onShow();
  check('从作品详情返回会刷新路线，及时检查隐藏与删除', calls.length === 2 && page.data.route === null);
  calls.at(-1).resolve(route()); await tick();
  const pull = page.onPullDownRefresh(); calls.at(-1).resolve(route()); await pull;
  check('详情下拉刷新完成后停止动画', !page.data.loading && h.refreshStops() === 3);
  page.onGoRoutes();
  check('详情提供查看其他路线入口', navigation.at(-1).url === '/pages/routes/index');
}

{
  const { page, calls } = harness(DETAIL);
  page.onLoad({ id: 'closed-route' });
  calls[0].reject({ code: 'NOT_FOUND', message: '路线可用机位不足，暂不可用' }); await tick();
  check('不足两个公开站点时显示不可用提示，移除旧路线', page.data.unavailable && !page.data.loading && page.data.route === null);
  const retry = page.onRetry(); calls.at(-1).reject(new Error('连接超时')); await retry;
  check('详情网络错误与路线不可用分别处理', page.data.error === '连接超时' && !page.data.unavailable && page.data.route === null);
  const recover = page.onRetry(); calls.at(-1).resolve(route()); await recover;
  check('详情失败后重试可以恢复公开路线', !page.data.error && !page.data.unavailable && !!page.data.route);
  const oldPromise = page.reload(), old = calls.at(-1);
  const newPromise = page.reload(), newer = calls.at(-1);
  newer.resolve(route('new')); await newPromise; old.resolve(route('old')); await oldPromise;
  check('旧路线详情不能覆盖新请求结果', page.data.route.id === 'new');
  const oldFailure = page.reload(), oldFailCall = calls.at(-1);
  const newest = page.reload(), newestCall = calls.at(-1);
  newestCall.resolve(route('latest')); await newest; oldFailCall.reject(new Error('旧错误')); await oldFailure;
  check('旧详情网络失败不影响新内容', page.data.route.id === 'latest' && !page.data.error);
}

{
  const h = harness(DETAIL); h.page.onLoad({ id: 'route' }); h.page.onUnload(); const before = h.patches();
  h.calls[0].resolve(route()); await tick();
  check('详情离开后的响应不更新页面', h.patches() === before);
  const missing = harness(DETAIL); missing.page.onLoad({}); await tick();
  check('缺少路线 ID 不发请求，展示明确不可用提示', missing.calls.length === 0 && missing.page.data.unavailable && !missing.page.data.loading);
  const encoded = harness(DETAIL); encoded.page.onLoad({ id: 'a/b?c' });
  check('路线 ID 编码后再用于请求地址', encoded.calls[0].url === '/routes/a%2Fb%3Fc');
  encoded.calls[0].reject({ code: 'NOT_FOUND', message: '不存在' }); await tick();
}

{
  const { page, calls, navigation } = harness('miniprogram/pages/discover/index.js');
  page.setData({ city: '上海市', keyword: '外滩', cityPickerOpen: true, shootingPickerOpen: true,
    shootingFilters: { bestTimes: ['night'], bestSeasons: [], focalLengths: [], difficulties: [] } });
  page.onRoutesTap();
  check('发现页新入口只打开路线页，不额外请求作品', navigation[0].url === '/pages/routes/index' && calls.length === 0);
  check('进入路线保留城市、关键词及拍摄条件，不建立地图联动', page.data.city === '上海市' && page.data.keyword === '外滩' && page.data.shootingFilters.bestTimes[0] === 'night');
  check('进入路线时关闭城市菜单和拍摄条件面板', !page.data.cityPickerOpen && !page.data.shootingPickerOpen);
}

const listMarkup = readFileSync(resolve(root, 'miniprogram/pages/routes/index.wxml'), 'utf8');
const detailMarkup = readFileSync(resolve(root, 'miniprogram/pages/routes/detail.wxml'), 'utf8');
check('列表明确路线独立浏览，并展示演示声明', listMarkup.includes('不受发现页城市和拍摄条件筛选影响') && listMarkup.includes('{{item.disclaimer}}'));
check('详情包含缺站说明、作品入口和准备提示', detailMarkup.includes('站序保留原编号') && detailMarkup.includes('bindtap="onSpotTap"') && detailMarkup.includes('route.preparation'));
check('路线页面没有增加地图或路线收藏按钮', !/<map\b/.test(detailMarkup + listMarkup) && !/bindtap="onFavorite/.test(detailMarkup + listMarkup));
check('列表空态与网络错误分开渲染', listMarkup.includes('wx:elif="{{error}}"') && listMarkup.includes('wx:elif="{{!routes.length}}"'));

console.log(`\n摄影路线页面离线回归通过：${passed} 项。`);

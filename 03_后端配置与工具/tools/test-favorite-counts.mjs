// Offline v1.5 regressions: no live API, account, favorite, or database writes.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const format = require('../miniprogram/utils/format.js');
const catalogue = require('../miniprogram/data/cities.js');
const shootingTime = require('../miniprogram/utils/shooting-time.js');
const tick = () => new Promise(done => setTimeout(done, 0));
const delay = ms => new Promise(done => setTimeout(done, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let passed = 0;
function check(label, value) { assert.ok(value, label); passed++; console.log(`[PASS] ${label}`); }
const event = dataset => ({ currentTarget: { dataset } });
const spot = (id = 'one', count = 0, extra = {}) => ({ id, title: id, status: 'active', favoriteCount: count,
  isFavorited: false, bestTimeLabels: [], bestSeasonLabels: [], photos: [], lat: 31, lng: 121,
  createdAt: '2026-09-18T00:00:00Z', author: {}, ...extra });
const DETAIL = 'miniprogram/pages/spot/detail.js', DISCOVER = 'miniprogram/pages/discover/index.js';
const MINE = 'miniprogram/pages/mine/index.js', ROUTE = 'miniprogram/pages/routes/detail.js';
function environment() {
  let app;
  const env = { pages: [] };
  vm.runInNewContext(readFileSync(resolve(root, 'miniprogram/app.js'), 'utf8'), {
    App: value => { app = value; }, getCurrentPages: () => env.pages,
    require: name => name.includes('auth') ? { ensureLogin: () => Promise.resolve() } : {}
  });
  app.globalData.user = { id: 'owner' };
  env.app = app;
  return env;
}
function harness(file, env = environment(), { realRequest = false } = {}) {
  const calls = [], toasts = [], logins = [];
  let login = () => Promise.resolve(env.app.globalData.user);
  let session = () => Promise.resolve(env.app.globalData.user);
  const auth = { currentUser: () => env.app.globalData.user,
    ensureLogin(force) { logins.push(force); return login(force); } };
  const storage = { pss_token: 'old-token' };
  const wx = { showToast: options => toasts.push(options.title), stopPullDownRefresh() {}, navigateTo() {}, hideKeyboard() {},
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    request(options) { calls.push({ ...options, respond: (statusCode, data) => options.success({ statusCode, data }) }); }
  };
  let request = options => {
    if (options.url === '/auth/me') return session();
    const d = deferred(); calls.push({ ...options, method: options.method || 'GET', resolve: d.resolve, reject: d.reject,
      items: (items = [], nextCursor = null) => d.resolve({ items, nextCursor }) });
    return d.promise;
  };
  if (realRequest) {
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(resolve(root, 'miniprogram/utils/request.js'), 'utf8'), {
      module, wx, getApp: () => env.app, console,
      require: name => name === '../config/index' ? { apiBaseUrl: 'http://offline/api/v1' } : auth
    });
    request = module.exports.request;
  }
  const mocks = { '../../utils/request': { request }, '../../utils/auth': auth,
    '../../utils/format': format, '../../utils/geo': { getUserLocation: () => Promise.resolve(null) },
    '../../utils/shooting-time': shootingTime, '../../data/cities': catalogue };
  let page;
  vm.runInNewContext(readFileSync(resolve(root, file), 'utf8'), {
    Page: value => { page = value; }, require: name => mocks[name], getApp: () => env.app,
    wx, setTimeout, clearTimeout
  });
  page.setData = patch => Object.assign(page.data, patch);
  return { page, calls, toasts, logins, env, setLogin: fn => { login = fn; }, setSession: fn => { session = fn; },
    setUser: id => { env.app.globalData.user = id ? { id } : null; } };
}
async function detail(count = 0, extra = {}, env) {
  const h = harness(DETAIL, env); h.page.onLoad({ id: 'one' }); await tick();
  h.calls[0].resolve(spot('one', count, extra)); await tick(); return h;
}
async function discovery(env) {
  const h = harness(DISCOVER, env); h.page.onLoad(); h.page.onShow(); await tick(); return h;
}
const ids = page => page.data.spots.map(item => item.id).join(',');

{
  const h = await detail(); check('详情明确保留0收藏数', h.page.data.spot.favoriteCount === 0);
  const pending = h.page.onFavoriteTap(); h.page.onFavoriteTap(); await tick();
  check('收藏计数操作仍防重复点击且不乐观加一', h.calls.length === 2 && h.page.data.spot.favoriteCount === 0 && h.page.data.favoritePending);
  check('收藏写入绑定明确当前账号', h.calls.at(-1).boundUserId === 'owner');
  h.calls.at(-1).resolve({ isFavorited: true, favoriteCount: 7 }); await pending;
  check('收藏成功直接使用服务端计数而不是本地加一', h.page.data.spot.favoriteCount === 7 && h.page.data.spot.isFavorited);
  check('收藏成功仅广播轻量revision', h.env.app.globalData.favoriteCountRevision === 1 && !Object.hasOwn(h.env.app.globalData, 'favorites'));
  const failed = h.page.onFavoriteTap(); await tick(); h.calls.at(-1).reject(new Error('取消失败')); await failed;
  check('取消失败不减计数、不改状态、不广播成功', h.page.data.spot.favoriteCount === 7 && h.page.data.spot.isFavorited && h.env.app.globalData.favoriteCountRevision === 1);
  const cancel = h.page.onFavoriteTap(); await tick(); h.calls.at(-1).resolve({ isFavorited: false, favoriteCount: 0 }); await cancel;
  check('取消成功可恢复0且解除操作锁', h.page.data.spot.favoriteCount === 0 && !h.page.data.spot.isFavorited && !h.page.data.favoritePending);
}
{
  const h = await detail(4); const pending = h.page.onFavoriteTap(); await tick();
  h.calls.at(-1).resolve({ isFavorited: true, favoriteCount: 4 }); await pending;
  check('服务端幂等收藏返回相同计数时不重复增加', h.page.data.spot.favoriteCount === 4);
  h.page.setData({ spot: { ...h.page.data.spot, isFavorited: true } }); const cancel = h.page.onFavoriteTap(); await tick();
  h.calls.at(-1).resolve({ isFavorited: false, favoriteCount: 4 }); await cancel;
  check('服务端幂等取消返回相同计数时不自行扣减', h.page.data.spot.favoriteCount === 4);
}
{
  const h = await detail(3); const pending = h.page.onFavoriteTap(); await tick(); const mutation = h.calls.at(-1);
  const reload = h.page.loadDetail(); await tick(); const stale = h.calls.at(-1);
  mutation.resolve({ isFavorited: true, favoriteCount: 9 }); await pending;
  stale.resolve(spot('one', 3, { isFavorited: false })); await reload;
  check('旧详情响应不能覆盖成功收藏后的计数和状态', h.page.data.spot.favoriteCount === 9 && h.page.data.spot.isFavorited && h.page.data.favoriteStateReady);
}
{
  const h = await detail(6); h.setLogin(() => Promise.reject(new Error('登录失败')));
  await h.page.onFavoriteTap();
  check('登录失败不提交收藏或改变计数', h.calls.length === 1 && h.page.data.spot.favoriteCount === 6 && h.env.app.globalData.favoriteCountRevision === 0);
}
{
  const h = await detail(3); const pending = h.page.onFavoriteTap(); await tick(); const mutation = h.calls.at(-1);
  const session = deferred(); h.setSession(() => session.promise);
  const reload = h.page.loadDetail(); await tick();
  mutation.resolve({ isFavorited: true, favoriteCount: 4 }); await pending;
  h.setUser('other'); session.resolve({ id: 'other' }); await tick();
  h.calls.at(-1).resolve(spot('one', 8, { isFavorited: false })); await reload;
  check('会话等待期间旧账号完成收藏不覆盖随后新账号详情状态', h.page.data.spot.isFavorited === false && h.page.favoriteOwnerId === 'other');
  check('跨账号详情采用新服务器计数而非旧账号回包计数', h.page.data.spot.favoriteCount === 8);
}
{
  const h = await detail(6); h.setUser(null); h.page.favoriteOwnerId = null; h.setLogin(() => Promise.resolve(null));
  await h.page.onFavoriteTap();
  check('无法确认身份时安全失败，绝不绕过绑定发收藏请求', h.calls.length === 1 && h.toasts.at(-1).includes('无法确认当前账号'));
}
{
  const h = await detail(6); const login = deferred(); h.setLogin(() => login.promise);
  const pending = h.page.onFavoriteTap(); h.setUser('other'); login.resolve({ id: 'owner' }); await tick();
  check('等待登录时换号不发送原收藏写入', !h.calls.some(call => call.method === 'PUT'));
  h.calls.at(-1).resolve(spot('one', 6, { isFavorited: true })); await pending;
  check('换号后只重新确认详情状态，计数不被自增', h.page.data.spot.favoriteCount === 6 && h.page.data.spot.isFavorited);
}
{
  const h = await detail(1); const pending = h.page.onFavoriteTap(); await tick(); const write = h.calls.at(-1);
  h.page.setData({ id: 'two', spot: spot('two', 15) }); write.resolve({ isFavorited: true, favoriteCount: 2 }); await pending;
  check('旧机位的收藏回包不覆盖新机位计数', h.page.data.spot.id === 'two' && h.page.data.spot.favoriteCount === 15);
}
{
  const h = await detail(5, { isFavorited: true }); h.setUser('other'); const returning = h.page.onShow();
  check('换账号回详情先置收藏状态为未就绪而非显示旧已收藏', h.page.data.loading && !h.page.data.favoriteStateReady);
  await tick(); h.calls.at(-1).resolve(spot('one', 5, { isFavorited: false })); await returning;
  check('换号回详情获取新本人状态且保留服务器总收藏数', !h.page.data.spot.isFavorited && h.page.data.spot.favoriteCount === 5 && h.page.data.favoriteStateReady);
}
{
  const h = await discovery(); check('发现页首次onShow不重复首屏请求', h.calls.length === 1);
  h.calls[0].items([spot('newer', 0), spot('older', 20)], 'time-cursor'); await tick();
  check('非搜索列表保留服务端发布时间顺序和0计数', ids(h.page) === 'newer,older' && h.page.data.spots[0].favoriteCount === 0 && !h.page.data.sortHint);
  h.page.setData({ province: '上海市', city: '上海市', keywordInput: '  外滩  ',
    shootingFilters: { bestTimes: ['night'], bestSeasons: ['winter'], focalLengths: ['tele'], difficulties: ['1'] } });
  const search = h.page.onSearchConfirm(); const searchCall = h.calls.at(-1);
  check('应用非空关键词后显示收藏排序提示', h.page.data.sortHint === '按收藏数排序');
  const query = new URL('http://offline' + searchCall.url).searchParams;
  check('搜索请求保留省市、关键词和全部拍摄条件', query.get('keyword') === '外滩' && query.get('province') === '上海市' && query.get('city') === '上海市' && query.get('bestTimes') === 'night' && query.get('bestSeasons') === 'winter' && query.get('focalLengths') === 'tele' && query.get('difficulties') === '1' && !query.has('cursor'));
  searchCall.items([spot('server-first', 8), spot('server-second', 10)], 'rank-cursor'); await search;
  check('前端不对单页自行按数量重排', ids(h.page) === 'server-first,server-second');
  const more = h.page.loadMore(); const moreQuery = new URL('http://offline' + h.calls.at(-1).url).searchParams;
  check('搜索翻页沿用服务端热度游标和全部条件', moreQuery.get('cursor') === 'rank-cursor' && moreQuery.get('keyword') === '外滩' && moreQuery.get('difficulties') === '1');
  h.calls.at(-1).items([spot('server-second', 11), spot('third', 0)], 'next-rank-cursor'); await more;
  check('动态排序分页按ID去重，保持首次顺序并更新返回计数', ids(h.page) === 'server-first,server-second,third' && h.page.data.spots[1].favoriteCount === 11);
  check('去重不自行改变服务器nextCursor', h.page.data.cursor === 'next-rank-cursor');
  const clear = h.page.onClearSearch(); const clearQuery = new URL('http://offline' + h.calls.at(-1).url).searchParams;
  check('清空搜索取消收藏排序提示、游标及关键词', !h.page.data.sortHint && !clearQuery.has('keyword') && !clearQuery.has('cursor'));
  check('清空关键词保留省市及拍摄条件', clearQuery.get('city') === '上海市' && clearQuery.get('bestTimes') === 'night');
  h.calls.at(-1).items([spot('latest', 0)]); await clear;
  const whitespace = h.page.onSearchInput({ detail: { value: '   ' } }); await whitespace;
  check('纯空格不启用收藏排序', !h.page.data.keyword && !h.page.data.sortHint);
}
{
  const h = await discovery(); h.calls[0].items([spot('old', 1)], 'old-cursor'); await tick();
  h.page.setData({ province: '湖北省', district: '仙桃市', keywordInput: '河边', keyword: '河边',
    shootingFilters: { bestTimes: ['sunset'], bestSeasons: [], focalLengths: [], difficulties: ['2'] } });
  const oldMore = h.page.loadMore(); const old = h.calls.at(-1);
  h.page.onHide(); const refresh = h.page.onShow(); const current = h.calls.at(-1);
  check('回发现页刷新首页而非沿用旧分页', current !== old && !current.url.includes('cursor='));
  check('回页保留省直辖地区、搜索与条件', current.url.includes(encodeURIComponent('仙桃市')) && current.url.includes(encodeURIComponent('河边')) && current.url.includes('difficulties=2'));
  current.items([spot('new-ranking', 17)], 'new-cursor'); await refresh; old.items([spot('old-page', 2)], 'old-more'); await oldMore;
  check('回页刷新隔离旧分页，避免新旧排序混杂', ids(h.page) === 'new-ranking' && h.page.data.cursor === 'new-cursor');
}
{
  const h = await discovery(); h.calls[0].items([spot('old')]); await tick();
  h.page.onSearchInput({ detail: { value: ' 新关键词 ' } }); h.page.onHide();
  const returning = h.page.onShow(); const query = new URL('http://offline' + h.calls.at(-1).url).searchParams;
  check('300ms防抖期间离开再返回，输入与实际搜索仍一致', h.page.data.keywordInput === ' 新关键词 ' && query.get('keyword') === '新关键词' && h.page.data.sortHint === '按收藏数排序');
  h.calls.at(-1).items([spot('result', 3)]); await returning; const before = h.calls.length; await delay(340);
  check('回页提交待搜索输入后不遗留重复防抖请求', h.calls.length === before);
}
{
  const env = environment(); const feed = await discovery(env); env.pages = [feed.page];
  feed.calls[0].items([spot('one', 0)]); await tick(); feed.page.onHide();
  const d = await detail(0, {}, env); env.pages = [feed.page, d.page];
  const pending = d.page.onFavoriteTap(); await tick(); const write = d.calls.at(-1);
  d.page.onUnload(); env.pages = [feed.page]; const returning = feed.page.onShow(); const returnCall = feed.calls.at(-1);
  returnCall.items([spot('one', 0)]); await returning; const before = feed.calls.length;
  write.resolve({ isFavorited: true, favoriteCount: 1 }); await pending;
  check('收藏在详情卸载后成功仍通知当前可见发现页刷新', feed.calls.length === before + 1 && env.app.globalData.favoriteCountRevision === 1);
  check('卸载后的收藏回包不写旧详情', d.page.data.spot.favoriteCount === 0 && !d.page.data.spot.isFavorited);
  feed.calls.at(-1).items([spot('one', 1)]); await tick();
  check('晚到收藏成功后发现卡片显示新的服务端计数', feed.page.data.spots[0].favoriteCount === 1);
  const beforeDuplicate = feed.calls.length; feed.page.onFavoriteCountsChanged();
  check('相同revision不会重复触发发现刷新', feed.calls.length === beforeDuplicate);
  feed.page.onHide(); env.pages = []; env.app.notifyFavoriteCountChange();
  check('不可见发现页不因轻量通知发请求', feed.calls.length === beforeDuplicate);
}
{
  const h = harness(MINE); h.env.pages = [h.page]; h.page.onLoad(); const mine = h.page.onShow(); await tick();
  h.calls.at(-1).items([spot('new', 0), spot('old', 100)]); await mine;
  check('我的作品显示收藏数但保持原发布时间顺序', h.page.data.list.spots.map(item => item.id).join(',') === 'new,old' && h.page.data.list.spots[0].favoriteCount === 0);
  const list = h.page.onSwitchTab(event({ tab: 'favorites' })); await tick();
  h.calls.at(-1).items([spot('recent-favorite', 1), spot('old-favorite', 200)]); await list;
  check('想去清单显示收藏数但保持收藏时间顺序', h.page.data.list.spots.map(item => item.id).join(',') === 'recent-favorite,old-favorite');
  const beforeCancel = h.calls.length;
  const cancel = h.page.onCancelFavorite(event({ id: 'recent-favorite' })); await tick(); h.calls.at(-1).resolve({ isFavorited: false, favoriteCount: 0 }); await tick();
  check('想去清单取消成功同步刷新revision和本页列表', h.env.app.globalData.favoriteCountRevision === 1 && h.calls.at(-1).url.includes('/favorites?'));
  check('清单自身取消通知不造成重复列表刷新', h.calls.length === beforeCancel + 2);
  h.calls.at(-1).items([spot('old-favorite', 200)]); await cancel;
}
{
  const h = harness(MINE); h.env.pages = [h.page]; h.page.onLoad();
  const loadMine = h.page.onShow(); await tick(); h.calls.at(-1).items([spot('one', 2)]); await loadMine;
  const loadFavorites = h.page.onSwitchTab(event({ tab: 'favorites' })); await tick(); h.calls.at(-1).items([spot('one', 2)]); await loadFavorites;
  const cancel = h.page.onCancelFavorite(event({ id: 'one' })); await tick(); const deletion = h.calls.at(-1);
  const switchMine = h.page.onSwitchTab(event({ tab: 'mine' })); await tick(); h.calls.at(-1).items([spot('one', 2)]); await switchMine;
  const before = h.calls.length; deletion.resolve({ isFavorited: false, favoriteCount: 1 }); await tick();
  for (const call of h.calls.slice(before)) call.items(call.url.includes('/mine?') ? [spot('one', 1)] : []);
  await cancel;
  check('取消收藏等待时切到我发布的，成功后保留标签并刷新我的计数', h.page.data.activeTab === 'mine' && h.page.data.list.spots[0].favoriteCount === 1 && h.page.data.favoritesList.spots.length === 0);
}
{
  const h = harness(ROUTE); h.page.onLoad({ id: 'route-one' });
  h.calls[0].resolve({ id: 'route-one', stops: [{ order: 1, spot: spot('first', 0) }, { order: 2, spot: spot('second', 100) }] }); await tick();
  check('路线卡片展示收藏数且保留人工站序', h.page.data.route.stops[0].spot.id === 'first' && h.page.data.route.stops[0].spot.favoriteCount === 0 && h.page.data.route.stops[1].spot.favoriteCount === 100);
}
for (const file of [MINE, ROUTE]) {
  const env = environment(), h = harness(file, env);
  if (file === MINE) {
    h.page.onLoad(); const loading = h.page.onShow(); await tick(); h.calls.at(-1).items([spot('one', 0)]); await loading;
  } else {
    h.page.onLoad({ id: 'route-one' }); h.calls.at(-1).resolve({ stops: [{ order: 1, spot: spot('one', 0) }] }); await tick();
  }
  const d = await detail(0, {}, env); const pending = d.page.onFavoriteTap(); await tick();
  env.pages = [h.page]; d.page.onUnload(); const before = h.calls.length;
  d.calls.at(-1).resolve({ isFavorited: true, favoriteCount: 1 }); await pending; await tick();
  check(`${file}回返已加载后收到晚到收藏会再次刷新计数`, h.calls.length === before + 1);
  if (file === MINE) h.calls.at(-1).items([spot('one', 1)]);
  else h.calls.at(-1).resolve({ stops: [{ order: 1, spot: spot('one', 1) }] });
  await tick();
}
{
  const h = harness(DETAIL, undefined, { realRequest: true });
  Object.assign(h.page, { unloaded: false, detailRevision: 0, favoriteRevision: 0, favoriteOwnerId: 'owner' });
  h.page.setData({ id: 'one', spot: spot('one', 5), loading: false, favoriteStateReady: true });
  h.setLogin(() => { h.setUser('owner'); return Promise.resolve({ id: 'owner' }); });
  const pending = h.page.onFavoriteTap(); await tick(); h.calls.at(-1).respond(401, { error: { code: 'UNAUTHORIZED' } }); await tick();
  check('同账号401重登仍重放原收藏操作', h.logins[1] === true && h.calls.at(-1).method === 'PUT');
  h.calls.at(-1).respond(200, { data: { isFavorited: true, favoriteCount: 6 } }); await pending;
  check('401恢复后使用返回计数更新', h.page.data.spot.favoriteCount === 6 && h.page.data.spot.isFavorited);
}
for (const file of ['miniprogram/pages/discover/index.wxml', 'miniprogram/pages/spot/detail.wxml', 'miniprogram/pages/mine/index.wxml', 'miniprogram/pages/routes/detail.wxml']) {
  const source = readFileSync(resolve(root, file), 'utf8');
  check(`${file}计数包括0均可见`, /\{\{(?:item\.spot|item|spot)\.favoriteCount\}\} 人收藏/.test(source) && !/wx:if="\{\{(?:item\.spot|item|spot)\.favoriteCount\}\}"/.test(source));
}
check('发现页搜索提示与keyword应用状态绑定', readFileSync(resolve(root, 'miniprogram/pages/discover/index.wxml'), 'utf8').includes('wx:if="{{sortHint}}"'));
console.log(`\n结果：${passed}/${passed} 项通过`);

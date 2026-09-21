// Offline VM tests: no real login, favorite, delete, or database mutations.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = createRequire(import.meta.url)('../miniprogram/data/cities.js');
const tick = () => new Promise(r => setTimeout(r, 0));
const event = dataset => ({ currentTarget: { dataset } });
const tab = value => event({ tab: value });
const city = code => event({ code });
const spot = (id, extra = {}) => ({ id, title: id, status: 'active', createdAt: '2026-09-18T00:00:00Z',
  bestTimeLabels: [], bestSeasonLabels: [], photos: [], lat: 31, lng: 121, isFavorited: false, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
let passed = 0;
function check(name, value) { assert.ok(value, name); passed++; console.log(`[PASS] ${name}`); }

function harness(file, { login = () => Promise.resolve(), session = () => Promise.resolve({ id: 'user' }), realRequest = false } = {}) {
  const calls = [], logins = [], toasts = [], navigation = [], modals = [];
  const sessionCalls = [];
  const app = { globalData: {} };
  const storage = { pss_token: 'old-token' };
  let refreshStops = 0;
  const auth = {
    ensureLogin(force) { logins.push(force); if (force) storage.pss_token = 'new-token'; return login(force); },
    currentUser: () => ({ id: 'user', nickname: '测试用户' })
  };
  const wx = {
    showToast: value => toasts.push(value.title),
    navigateTo: value => navigation.push(value.url), switchTab: value => navigation.push(value.url),
    stopPullDownRefresh: () => { refreshStops++; },
    showModal: value => modals.push(value),
    openLocation: value => navigation.push(value.name),
    setClipboardData: value => { navigation.push(value.data); value.success(); },
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; },
    request(options) {
      calls.push({ ...options, params: new URL(options.url).searchParams,
        respond(statusCode, data) { options.success({ statusCode, data }); } });
    }
  };
  let request = options => {
    if (options.url === '/auth/me') {
      sessionCalls.push(options);
      return session();
    }
    const waiting = deferred();
    calls.push({ ...options, method: options.method || 'GET',
      params: new URL('http://test' + options.url).searchParams,
      resolve: waiting.resolve, reject: waiting.reject,
      items(items = [], nextCursor = '') { waiting.resolve({ items, nextCursor }); }
    });
    return waiting.promise;
  };
  if (realRequest) {
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(resolve(root, 'miniprogram/utils/request.js'), 'utf8'), {
      module, wx, getApp: () => app, console,
      require: key => key === '../config/index' ? { apiBaseUrl: 'http://offline/api/v1' } : auth
    });
    request = module.exports.request;
  }
  const mocks = {
    '../../utils/request': { request }, '../../utils/auth': auth,
    '../../utils/format': { formatDate: () => '刚刚', formatDistance: () => '', buildTags: () => [] },
    '../../data/cities': catalogue
  };
  let page;
  vm.runInNewContext(readFileSync(resolve(root, file), 'utf8'), {
    require: key => mocks[key], Page: definition => { page = definition; },
    wx, getApp: () => app, setTimeout, clearTimeout
  });
  page.setData = patch => Object.assign(page.data, patch);
  return { page, calls, logins, toasts, navigation, modals, sessionCalls, refreshStops: () => refreshStops };
}

const DETAIL = 'miniprogram/pages/spot/detail.js';
const MINE = 'miniprogram/pages/mine/index.js';

{
  const h = harness(DETAIL), { page, calls, logins, toasts, navigation } = h;
  page.onLoad({ id: 'one' }); await tick(); calls[0].resolve(spot('one')); await tick();
  check('详情校验登录会话后展示收藏状态', h.sessionCalls.length === 1 && page.data.favoriteStateReady && page.data.spot.isFavorited === false);
  const pending = page.onFavoriteTap(); page.onFavoriteTap();
  check('收藏前先登录且立即锁定重复操作', page.data.favoritePending && logins.length === 2 && calls.length === 1);
  await tick(); check('公开作品通过 PUT 收藏', calls.at(-1).method === 'PUT' && calls.at(-1).url === '/spots/one/favorite');
  check('请求期间不提前改变收藏状态', page.data.spot.isFavorited === false);
  calls.at(-1).resolve({ isFavorited: true }); await pending;
  check('成功后更新收藏按钮并解除锁定', page.data.spot.isFavorited && !page.data.favoritePending && toasts.at(-1) === '已加入想去清单');
  const cancel = page.onFavoriteTap(); await tick();
  check('已收藏作品通过 DELETE 取消', calls.at(-1).method === 'DELETE');
  calls.at(-1).reject({ message: '网络失败' }); await cancel;
  check('取消失败保留原状态并可重试', page.data.spot.isFavorited && !page.data.favoritePending && toasts.at(-1) === '网络失败');
  const retry = page.onFavoriteTap(); await tick(); calls.at(-1).resolve({ isFavorited: false }); await retry;
  check('取消重试成功', page.data.spot.isFavorited === false);
  page.setData({ spot: spot('one', { status: 'hidden' }) }); const before = calls.length;
  await page.onFavoriteTap(); check('非公开作品不可新增收藏', calls.length === before && toasts.at(-1) === '仅公开作品可以收藏');
  page.setData({ spot: spot('one', { status: 'hidden', isFavorited: true }) });
  const hiddenCancel = page.onFavoriteTap(); await tick(); calls.at(-1).resolve({ isFavorited: false }); await hiddenCancel;
  check('非公开作品的现有收藏仍可取消', !page.data.spot.isFavorited && calls.at(-1).method === 'DELETE');
  page.setData({ spot: spot('one', { isMine: true }) });
  const ownFavorite = page.onFavoriteTap(); await tick(); calls.at(-1).resolve({ isFavorited: true }); await ownFavorite;
  check('作者可收藏自己的公开作品', page.data.spot.isFavorited);
  page.onCopyCoordinate(); page.onNavigateTap(); page.onEditTap();
  check('保留复制、导航和编辑入口', navigation.includes('31.000000,121.000000') && navigation.includes('one') && navigation.includes('/pages/spot/create?id=one'));
  const newerCancel = page.onFavoriteTap(); await tick(); const cancelRequest = calls.at(-1);
  page.loadDetail(); await tick(); const olderDetail = calls.at(-1);
  cancelRequest.resolve({ isFavorited: false }); await newerCancel;
  olderDetail.resolve(spot('one', { isFavorited: true })); await tick();
  check('旧详情响应不覆盖已成功的收藏变更和就绪状态', !page.data.spot.isFavorited && page.data.favoriteStateReady);
  const leaving = page.onFavoriteTap(); await tick(); const leavingCall = calls.at(-1); page.onUnload();
  leavingCall.resolve({ isFavorited: true }); await leaving;
  check('详情卸载后的变更响应不写页面', !page.data.spot.isFavorited);
}

{
  let failLogin = false;
  const { page, calls, toasts } = harness(DETAIL, { login: () => failLogin ? Promise.reject(new Error('登录失败')) : Promise.resolve() });
  page.onLoad({ id: 'one' }); await tick(); calls[0].resolve(spot('one')); await tick(); failLogin = true; await page.onFavoriteTap();
  check('登录失败不发送收藏请求', calls.length === 1 && !page.data.favoritePending && !page.data.spot.isFavorited && toasts.at(-1) === '登录失败');
}

{
  const { page, calls, logins } = harness(DETAIL, { realRequest: true });
  page.onLoad({ id: 'one' }); await tick(); calls[0].respond(200, { data: { id: 'user' } }); await tick();
  calls[1].respond(200, { data: spot('one') }); await tick();
  const favorite = page.onFavoriteTap(); await tick(); calls.at(-1).respond(401, { error: { code: 'UNAUTHORIZED', message: '已过期' } }); await tick();
  check('收藏沿用请求层的 401 自动重登', logins.length === 3 && logins[2] === true && calls.at(-1).header.Authorization === 'Bearer new-token');
  check('重登后重放原收藏操作', calls.at(-1).method === 'PUT' && calls.at(-1).url.endsWith('/spots/one/favorite'));
  calls.at(-1).respond(200, { data: { isFavorited: true } }); await favorite;
  check('401 恢复后正常更新按钮', page.data.spot.isFavorited && !page.data.favoritePending);
}

{
  const login = deferred();
  const { page, calls, sessionCalls } = harness(DETAIL, { login: () => login.promise });
  page.onLoad({ id: 'existing' }); await tick();
  check('详情等待首次异步登录，不提前请求匿名状态', !calls.length && !sessionCalls.length && page.data.loading && !page.data.favoriteStateReady);
  login.resolve(); await tick();
  check('首次登录完成后先验证会话再请求详情', sessionCalls.length === 1 && calls.length === 1 && calls[0].url === '/spots/existing');
  calls[0].resolve(spot('existing', { isFavorited: true })); await tick();
  check('首次登录后识别已有收藏', page.data.favoriteStateReady && page.data.spot.isFavorited);
  const cancel = page.onFavoriteTap(); await tick();
  check('已存在收藏首次点击执行取消而非重复收藏', calls.at(-1).method === 'DELETE');
  calls.at(-1).resolve({ isFavorited: false }); await cancel;
}

{
  const { page, calls, logins } = harness(DETAIL, { realRequest: true });
  page.onLoad({ id: 'expired' }); await tick();
  check('公共详情之前使用鉴权接口检测旧令牌', calls.length === 1 && calls[0].url.endsWith('/auth/me') && calls[0].header.Authorization === 'Bearer old-token');
  calls[0].respond(401, { error: { code: 'UNAUTHORIZED', message: '旧令牌已过期' } }); await tick();
  check('会话校验的 401 触发自动重登及校验重放', logins[1] === true && calls.length === 2 && calls[1].url.endsWith('/auth/me') && calls[1].header.Authorization === 'Bearer new-token');
  calls[1].respond(200, { data: { id: 'user' } }); await tick();
  check('公共详情携带经过验证的新令牌', calls.length === 3 && calls[2].url.endsWith('/spots/expired') && calls[2].header.Authorization === 'Bearer new-token');
  calls[2].respond(200, { data: spot('expired', { isFavorited: true }) }); await tick();
  check('过期会话恢复后不误显示为未收藏', page.data.favoriteStateReady && page.data.spot.isFavorited);
  const cancel = page.onFavoriteTap(); await tick();
  check('过期会话恢复后第一次收藏操作是取消', calls.at(-1).method === 'DELETE');
  calls.at(-1).respond(200, { data: { isFavorited: false } }); await cancel;
}

{
  let sessionFails = true;
  const { page, calls, sessionCalls } = harness(DETAIL, {
    session: () => sessionFails ? Promise.reject(new Error('会话服务不可用')) : Promise.resolve({ id: 'user' })
  });
  page.onLoad({ id: 'public' }); await tick(); calls[0].resolve(spot('public')); await tick();
  check('会话失败仍允许浏览公开详情', page.data.spot.id === 'public' && !page.data.loading && !page.data.favoriteStateReady);
  const retry = page.onFavoriteTap(); page.onFavoriteTap(); await tick();
  check('未知收藏状态点击只重试加载且阻止重复操作', page.data.loading && calls.length === 2 && sessionCalls.length === 2 && calls.every(c => c.method === 'GET'));
  calls.at(-1).resolve(spot('public')); await retry;
  check('重试会话仍失败时不猜测或写入收藏状态', !page.data.favoriteStateReady && !page.data.favoritePending && calls.every(c => c.method === 'GET'));
  sessionFails = false;
  const restored = page.onFavoriteTap(); await tick(); calls.at(-1).resolve(spot('public', { isFavorited: true })); await restored;
  check('未知状态重试成功只恢复真实状态，不自动切换收藏', page.data.favoriteStateReady && page.data.spot.isFavorited && calls.every(c => c.method === 'GET'));
  const cancel = page.onFavoriteTap(); await tick(); calls.at(-1).resolve({ isFavorited: false }); await cancel;
  check('恢复真实状态后用户再次点击可正常取消', calls.at(-1).method === 'DELETE' && !page.data.spot.isFavorited);
}

{
  const { page, calls, sessionCalls } = harness(DETAIL, { login: () => Promise.reject(new Error('无法登录')) });
  page.onLoad({ id: 'public' }); await tick(); calls[0].resolve(spot('public')); await tick();
  check('首次登录失败不阻断公开浏览且收藏状态未知', page.data.spot.id === 'public' && !page.data.favoriteStateReady && !sessionCalls.length);
}

{
  let sessionFails = true;
  const { page, calls } = harness(DETAIL, { session: () => sessionFails ? Promise.reject(new Error('会话失败')) : Promise.resolve() });
  page.onLoad({ id: 'race' }); await tick(); const older = calls[0];
  sessionFails = false; page.loadDetail(); await tick(); calls.at(-1).resolve(spot('race', { isFavorited: true })); await tick();
  older.resolve(spot('race')); await tick();
  check('旧匿名详情不覆盖新会话的收藏状态及就绪状态', page.data.favoriteStateReady && page.data.spot.isFavorited);
}

{
  const h = harness(MINE), { page, calls, logins, toasts, navigation, modals } = h;
  page.onLoad(); page.onShow();
  check('我的页默认我发布的，首屏先登录', page.data.activeTab === 'mine' && logins.length === 1 && !calls.length);
  await tick(); const oldMine = calls[0];
  check('我发布的独立分页请求', oldMine.url.startsWith('/spots/mine?') && oldMine.params.get('limit') === '10');
  page.onSwitchTab(tab('favorites')); await tick();
  check('想去清单默认全部城市，不请求定位', calls.at(-1).url.startsWith('/spots/favorites?') && !calls.at(-1).params.has('city') && page.data.cityLabel === '全部城市');
  calls.at(-1).items([spot('saved')], 'f-next'); await tick();
  oldMine.items([spot('mine-old', { status: 'pending' })], 'm-next'); await tick();
  check('不同标签的响应不混入当前清单', page.data.list.spots[0].id === 'saved' && page.data.mineList.spots[0].id === 'mine-old');
  check('原发布状态提示保留', page.data.mineList.spots[0].statusText === '审核中');
  page.loadMore(); page.loadMore(); await tick();
  check('收藏分页保留自己的游标且阻止重复请求', calls.length === 3 && calls.at(-1).params.get('cursor') === 'f-next');
  const oldPage = calls.at(-1);
  page.onToggleCity(); check('收藏城市菜单展开', page.data.cityPickerOpen);
  page.onCloseCityPicker(); check('收藏城市菜单可关闭', !page.data.cityPickerOpen);
  page.onSelectProvince(city('330000')); const beforeProvince = calls.length;
  check('切换省份不直接请求清单', calls.length === beforeProvince && page.data.pickerCities.some(c => c.name === '杭州市'));
  page.onSelectCity(city('330100')); await tick();
  check('普通城市传省市且重置游标', calls.at(-1).params.get('province') === '浙江省' && calls.at(-1).params.get('city') === '杭州市' && !calls.at(-1).params.has('cursor') && !page.data.cityPickerOpen);
  calls.at(-1).items([spot('hangzhou')], 'h-next'); await tick(); oldPage.items([spot('stale')]); await tick();
  check('旧收藏分页不会混入新城市结果', page.data.list.spots.length === 1 && page.data.list.spots[0].id === 'hangzhou');
  page.onSelectProvince(city('310000')); page.onSelectCity(city('310000')); await tick();
  check('直辖市按省市查询', calls.at(-1).params.get('province') === '上海市' && calls.at(-1).params.get('city') === '上海市');
  const obsoleteCity = calls.at(-1);
  page.onSelectProvince(city('420000')); page.onSelectCity(city('429004')); await tick();
  check('省直辖地区按省区县查询', calls.at(-1).params.get('province') === '湖北省' && calls.at(-1).params.get('district') === '仙桃市' && !calls.at(-1).params.has('city'));
  calls.at(-1).items([]); await tick(); obsoleteCity.reject({ message: '旧城市请求错误' }); await tick();
  check('筛选无结果与旧请求错误区分', page.data.list.finished && page.data.list.loaded && !page.data.list.error && !page.data.list.spots.length && page.data.selectedCityCode === '429004');
  page.onSelectAllCities(); await tick();
  check('切换全部城市清除全部地域条件', ['province', 'city', 'district', 'cursor'].every(k => !calls.at(-1).params.has(k)));
  calls.at(-1).items([]); await tick();
  check('空收藏清单有独立的已加载状态', !page.data.selectedCityCode && page.data.list.loaded && !page.data.list.error);
  page.onGoDiscover(); check('空清单可前往发现标签', navigation.at(-1) === '/pages/discover/index');
  page.onShow(); await tick();
  check('返回我的页保留当前标签并重新请求', page.data.activeTab === 'favorites' && calls.at(-1).url.startsWith('/spots/favorites?'));
  calls.at(-1).reject({ message: '后端暂时不可用' }); await tick();
  check('网络失败不当成空收藏', page.data.list.error === '后端暂时不可用' && !page.data.list.loading && !page.data.list.loaded);
  page.onRetry(); await tick(); calls.at(-1).items([spot('saved')], 'retry-next'); await tick();
  check('收藏首页失败可重试恢复', page.data.list.spots[0].id === 'saved' && !page.data.list.error);
  page.loadMore(); await tick(); calls.at(-1).reject({ message: '下一页失败' }); await tick();
  check('收藏下一页失败保留已加载作品', page.data.list.spots[0].id === 'saved' && page.data.list.error === '下一页失败');
  page.onRetry(); await tick(); check('收藏下一页重试使用原游标', calls.at(-1).params.get('cursor') === 'retry-next');
  calls.at(-1).items([spot('second')], 'last-page'); await tick();
  check('收藏下一页追加成功', page.data.list.spots.length === 2 && !page.data.list.error);
  const cancel = page.onCancelFavorite(event({ id: 'saved' })); page.onCancelFavorite(event({ id: 'saved' })); await tick();
  check('清单取消收藏登录并防止重复点击', page.data.favoritePending.saved && calls.at(-1).method === 'DELETE' && calls.at(-1).url === '/spots/saved/favorite');
  calls.at(-1).reject({ message: '取消失败' }); await cancel;
  check('清单取消失败保留作品并解锁', page.data.list.spots.length === 2 && !page.data.favoritePending.saved && toasts.at(-1) === '取消失败');
  page.loadMore(); await tick(); const beforeDeletePage = calls.at(-1);
  const cancelled = page.onCancelFavorite(event({ id: 'saved' })); await tick(); calls.at(-1).resolve({ isFavorited: false }); await tick();
  check('取消成功重新加载收藏首页', calls.at(-1).url.startsWith('/spots/favorites?') && !calls.at(-1).params.has('cursor'));
  calls.at(-1).items([spot('second')]); await cancelled; beforeDeletePage.items([spot('saved')]); await tick();
  check('已取消作品不会被旧分页重新加入', page.data.list.spots.length === 1 && page.data.list.spots[0].id === 'second' && !page.data.favoritePending.saved);
  page.onSelectProvince(city('310000')); page.onSelectCity(city('310000')); await tick(); calls.at(-1).items([spot('shanghai')], 'shanghai-next'); await tick();
  const refresh = page.onPullDownRefresh(); await tick();
  check('收藏下拉刷新保留城市且重置游标', calls.at(-1).params.get('city') === '上海市' && !calls.at(-1).params.has('cursor'));
  calls.at(-1).items([spot('refreshed')]); await refresh;
  check('刷新完成结束下拉动画', h.refreshStops() === 1);
  page.onSwitchTab(tab('mine')); await tick();
  check('发布标签不受收藏城市条件影响', calls.at(-1).url.startsWith('/spots/mine?') && !calls.at(-1).params.has('city'));
  calls.at(-1).items([spot('owned')], 'mine-next'); await tick(); page.loadMore(); await tick();
  check('发布标签使用自己的游标', calls.at(-1).params.get('cursor') === 'mine-next');
  calls.at(-1).items([spot('owned-second')]); await tick();
  page.onSpotTap(event({ id: 'owned' })); page.onEditTap(event({ id: 'owned' })); page.onCreateTap(); page.onOpenLegal(event({ type: 'privacy' }));
  check('原详情编辑新建隐私入口保留', ['/pages/spot/detail?id=owned', '/pages/spot/create?id=owned', '/pages/spot/create', '/pages/legal/index?type=privacy'].every(url => navigation.includes(url)));
  page.onDeleteTap(event({ id: 'owned', title: 'owned' })); modals.at(-1).success({ confirm: false });
  const confirmed = modals.at(-1).success({ confirm: true }); await tick();
  check('原删除流程仍要求确认', calls.at(-1).url === '/spots/owned' && calls.at(-1).method === 'DELETE');
  calls.at(-1).resolve({ ok: true }); await confirmed; await tick(); calls.at(-1).items([]); await tick();
  check('删除后刷新发布列表', !page.data.mineList.spots.length && page.data.mineList.loaded);
  page.onSwitchTab(tab('favorites')); await tick(); calls.at(-1).items([spot('fresh')]); await tick();
  page.onToggleCity(); page.onHide(); check('离开页面关闭城市菜单但保留条件', !page.data.cityPickerOpen && page.data.city === '上海市');
  page.onShow(); await tick(); const leaving = calls.at(-1); page.onUnload(); leaving.items([spot('after-unload')]); await tick();
  check('卸载后收藏响应不再更新页面', !page.data.list.spots.length);
}

{
  const login = deferred();
  const { page, calls } = harness(MINE, { login: () => login.promise });
  page.onLoad(); page.onShow(); page.onSwitchTab(tab('favorites')); page.onSwitchTab(tab('mine'));
  login.resolve(); await tick();
  check('延迟登录不会重放已失效的同标签首屏请求', calls.filter(c => c.url.startsWith('/spots/mine?')).length === 1);
  const first = calls.find(c => c.url.startsWith('/spots/mine?')); page.reload(); await tick();
  calls.at(-1).items([spot('latest')]); await tick(); first.items([spot('obsolete')]); await tick();
  check('同标签旧首页响应不能覆盖新首页', page.data.list.spots[0].id === 'latest');
}

{
  const { page, calls } = harness(MINE, { login: () => Promise.reject(new Error('需要重新登录')) });
  page.onLoad(); await page.onShow();
  check('我的页登录失败显示错误而非空清单', !calls.length && page.data.list.error === '需要重新登录' && !page.data.list.loaded);
}

for (const [template, script] of [['miniprogram/pages/mine/index.wxml', MINE], ['miniprogram/pages/spot/detail.wxml', DETAIL]]) {
  const { page } = harness(script);
  const markup = readFileSync(resolve(root, template), 'utf8');
  const handlers = [...markup.matchAll(/(?:bind|catch)[a-z]+="([A-Za-z][A-Za-z0-9]+)"/g)].map(match => match[1]);
  check(`${template} 所有交互绑定均存在`, handlers.every(handler => typeof page[handler] === 'function'));
}

console.log(`\n结果：${passed}/${passed} 项通过`);

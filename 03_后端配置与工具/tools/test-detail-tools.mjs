// Offline regressions; no network, database, login, or real feedback writes.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shootingTime = createRequire(import.meta.url)('../miniprogram/utils/shooting-time.js');
const tick = () => new Promise(done => setTimeout(done, 0));
let passed = 0;
function check(label, condition) { assert.ok(condition, label); passed++; console.log(`[PASS] ${label}`); }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const spot = (extra = {}) => ({ id: 'spot-one', title: '测试机位', status: 'active', createdAt: '2026-09-18T00:00:00Z',
  bestTimeLabels: [], bestSeasonLabels: [], photos: [], author: {}, lat: 31, lng: 121, ...extra });
const feedback = (id, kind = 'still_accessible', isMine = false) => ({ id, kind, label: '仍可拍摄',
  updatedAt: '2026-09-18T00:00:00Z', isMine });
const feedbackResult = (items = [], nextCursor = null, myFeedback = null) => ({ items, nextCursor, myFeedback, windowDays: 30 });
const times = (date = '2026-09-18', extra = {}) => ({ date, timeZone: 'Asia/Shanghai', sunrise: `${date}T05:41:00+08:00`,
  sunset: `${date}T18:02:00+08:00`, goldenMorning: { start: `${date}T05:25:00+08:00`, end: `${date}T06:11:00+08:00` },
  goldenEvening: { start: `${date}T17:31:00+08:00`, end: `${date}T18:20:00+08:00` },
  blueMorning: { start: `${date}T05:05:00+08:00`, end: `${date}T05:25:00+08:00` },
  blueEvening: { start: `${date}T18:20:00+08:00`, end: `${date}T18:40:00+08:00` }, notes: ['理论参考，未计天气及遮挡'], ...extra });
const choose = kind => ({ currentTarget: { dataset: { kind } } });
const dateEvent = value => ({ detail: { value } });

function harness({ login = () => Promise.resolve({ id: 'owner' }), realRequest = false, initialUser = 'owner', fallback = false } = {}) {
  const calls = [], logins = [], toasts = [], storage = { pss_token: 'old-token' };
  let currentUser = initialUser ? { id: initialUser } : null;
  const app = { globalData: { user: currentUser } };
  const auth = { currentUser: () => currentUser,
    ensureLogin(force) { logins.push(force); if (force) storage.pss_token = 'new-token'; return login(force); } };
  const wx = { showToast: value => toasts.push(value.title), navigateTo() {},
    getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value; },
    removeStorageSync: key => { delete storage[key]; if (key === 'pss_user') currentUser = null; },
    request(options) { calls.push({ ...options, respond: (statusCode, data) => options.success({ statusCode, data }),
      failNetwork: () => options.fail({ errMsg: 'request:fail offline' }) }); }
  };
  let request = options => {
    if (options.url === '/auth/me') return Promise.resolve({ id: 'owner' });
    const waiting = deferred();
    calls.push({ ...options, method: options.method || 'GET', resolve: waiting.resolve, reject: waiting.reject });
    return waiting.promise;
  };
  if (realRequest) {
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(resolve(root, 'miniprogram/utils/request.js'), 'utf8'), {
      module, wx, getApp: () => app, console, require: key => key === '../config/index'
        ? { apiBaseUrl: 'http://offline/api/v1', fallbackApiBaseUrls: fallback ? ['http://fallback/api/v1'] : [] } : auth
    });
    request = module.exports.request;
  }
  const mocks = { '../../utils/request': { request }, '../../utils/auth': auth,
    '../../utils/format': { formatDate: () => '刚刚', formatDistance: () => '' }, '../../utils/shooting-time': shootingTime };
  let page;
  vm.runInNewContext(readFileSync(resolve(root, 'miniprogram/pages/spot/detail.js'), 'utf8'), {
    require: key => mocks[key], Page: definition => { page = definition; }, wx,
    getApp: () => ({ globalData: {} }), setTimeout, clearTimeout
  });
  page.setData = patch => Object.assign(page.data, patch);
  return { page, calls, logins, toasts, wx,
    setUser(id) { currentUser = id ? { id } : null; app.globalData.user = currentUser; },
    setLogin(fn) { auth.ensureLogin = force => { logins.push(force); if (force) storage.pss_token = 'new-token'; return fn(force); }; }
  };
}
async function boot(options, item = spot(), readyFirst = true) {
  const h = harness(options);
  h.page.onLoad({ id: item.id });
  if (readyFirst) h.page.onReady();
  await tick();
  h.calls[0].resolve(item); await tick();
  if (!readyFirst) { h.page.onReady(); await tick(); }
  return h;
}
const feedbackCall = h => h.calls.findLast(call => call.method === 'GET' && call.url.includes('/feedback?'));
const timeCall = h => h.calls.findLast(call => call.url.includes('/shooting-times?'));
async function settle(h, items = [], cursor = null, mine = null) {
  feedbackCall(h).resolve(feedbackResult(items, cursor, mine));
  timeCall(h).resolve(times(h.page.data.shootingDate));
  await tick();
}

check('北京时间日期不使用设备本地日期', shootingTime.beijingDate(Date.parse('2026-09-17T17:00:00Z')) === '2026-09-18');
check('北京时间凌晨前仍为前一天', shootingTime.beijingDate(Date.parse('2026-09-17T15:59:59Z')) === '2026-09-17');
check('跨年日期正确', shootingTime.beijingDate(Date.parse('2026-12-31T16:00:00Z')) === '2027-01-01');
check('合法闰日与起止年份通过', ['2000-02-29', '2024-02-29', '2100-12-31'].every(shootingTime.validDate));
check('非法日期、越界年份与时区字符串拒绝', ['2026-02-29', '2100-02-29', '1999-12-31', '2101-01-01', '2026-1-1', '2026-09-18Z', null].every(value => !shootingTime.validDate(value)));
check('ISO转北京时间不受本机时区影响', shootingTime.beijingTime('2026-09-17T22:30:00Z', '2026-09-18') === '06:30');
check('跨日时段明确标明日期', shootingTime.beijingTime('2026-09-17T23:50:00+08:00', '2026-09-18') === '2026-09-17 23:50');
check('六类时段均显示且缺失时段明确提示', shootingTime.rows(times(undefined, { blueMorning: null })).length === 6 && shootingTime.rows(times(undefined, { blueMorning: null }))[4].text === '当日无此时段');

{
  const h = harness(); h.page.onLoad({ id: 'spot-one' }); h.page.onReady(); await tick();
  check('详情返回前不查询新卡片', h.calls.length === 1);
  h.calls[0].resolve(spot()); await tick();
  check('页面就绪与详情完成后独立加载两张卡片', h.calls.length === 3 && Boolean(feedbackCall(h)) && Boolean(timeCall(h)));
  check('反馈默认每页5条且无游标', feedbackCall(h).url.endsWith('/feedback?limit=5'));
  check('日期默认北京时间今天', h.page.data.shootingDate === shootingTime.beijingDate());
  check('时间请求携带所选日期', timeCall(h).url.endsWith(`date=${h.page.data.shootingDate}`));
  await settle(h);
  check('空反馈只在成功返回后进入空状态', h.page.data.feedbackLoaded && !h.page.data.feedbackError && h.page.data.feedbackItems.length === 0);
  check('时间响应展示日出日落与四个光线时段', h.page.data.shootingLoaded && h.page.data.shootingRows.length === 6 && h.page.data.shootingRows[0].text === '05:41');
  check('详情不会因为新卡片读取重复查询', h.calls.filter(call => /\/spots\/spot-one$/.test(call.url)).length === 1);
}
{
  const h = await boot({}, spot(), false);
  check('详情先完成、onReady后到同样启动卡片', h.calls.length === 3);
  await settle(h);
}
for (const status of ['pending', 'hidden', 'deleted']) {
  const h = await boot({}, spot({ status, isMine: true }));
  check(`${status}作者详情不调用公开工具接口`, h.calls.length === 1 && h.page.data.spot.isMine && h.page.data.feedbackItems.length === 0);
  h.page.onChooseFeedback(choose('obstructed')); await h.page.onSubmitFeedback(); await h.page.onShootingRetry();
  check(`${status}工具操作不发出写入或时间请求`, h.calls.length === 1);
}
{
  const h = await boot({ login: () => Promise.reject(new Error('暂时无法登录')), initialUser: null });
  check('登录失败仍可匿名加载公开反馈及时间', Boolean(feedbackCall(h)) && Boolean(timeCall(h)));
  await settle(h, [feedback('other')]);
  h.page.onChooseFeedback(choose('still_accessible')); const before = h.calls.length;
  await h.page.onSubmitFeedback();
  check('反馈登录失败不发送PUT且保留列表', h.calls.length === before && h.page.data.feedbackItems.length === 1 && h.page.data.feedbackActionError === '暂时无法登录');
  check('反馈登录失败解除提交锁且允许重试', !h.page.data.feedbackPending && h.toasts.at(-1) === '暂时无法登录');
}
{
  const h = await boot(); feedbackCall(h).reject(new Error('反馈网络断开')); timeCall(h).resolve(times()); await tick();
  check('反馈网络错误不伪装为空状态且不影响时间', !h.page.data.feedbackLoaded && h.page.data.feedbackError === '反馈网络断开' && h.page.data.shootingLoaded);
  const retry = h.page.onFeedbackRetry(); feedbackCall(h).resolve(feedbackResult([feedback('one')], 'cursor +/=')); await retry;
  check('反馈首页失败可以独立重试', h.page.data.feedbackItems[0].id === 'one' && !h.page.data.feedbackError);
  const more = h.page.onFeedbackMore(); const count = h.calls.length; h.page.onFeedbackMore();
  check('反馈分页保留并编码游标、阻止重复请求', feedbackCall(h).url.endsWith('cursor=cursor%20%2B%2F%3D') && h.calls.length === count);
  feedbackCall(h).reject(new Error('分页失败')); await more;
  check('分页失败保留既有条目和游标', h.page.data.feedbackItems.length === 1 && h.page.data.feedbackCursor === 'cursor +/=');
  const repeat = h.page.onFeedbackRetry(); check('分页失败重试原游标', feedbackCall(h).url.includes('cursor='));
  feedbackCall(h).resolve(feedbackResult([feedback('one'), feedback('two')], null)); await repeat;
  check('追加分页去重且结束游标', h.page.data.feedbackItems.length === 2 && !h.page.data.feedbackCursor);
}
{
  const h = await boot(); await settle(h, [feedback('other')]);
  const before = h.calls.length; h.page.onChooseFeedback(choose('bad')); await h.page.onSubmitFeedback();
  check('非法或未选反馈不提交', h.calls.length === before && h.toasts.at(-1) === '请先选择一种现场情况');
  h.page.onChooseFeedback(choose('obstructed'));
  check('选择反馈暂不提交，四类选项完整', h.calls.length === before && h.page.data.feedbackOptions.length === 4 && h.page.data.feedbackKind === 'obstructed');
  const pending = h.page.onSubmitFeedback(); h.page.onSubmitFeedback(); h.page.onChooseFeedback(choose('still_accessible'));
  check('反馈提交立即锁定且禁止修改选择', h.page.data.feedbackPending && h.page.data.feedbackKind === 'obstructed');
  await tick(); const write = h.calls.at(-1);
  check('鉴权PUT只提交所选kind而不提交用户ID', write.method === 'PUT' && JSON.stringify(write.data) === '{"kind":"obstructed"}');
  write.reject(new Error('写入失败')); await pending;
  check('写入失败保留原列表和本人状态', h.page.data.feedbackItems[0].id === 'other' && h.page.data.myFeedback === null && h.page.data.feedbackActionError === '写入失败');
  const retry = h.page.onFeedbackActionRetry(); await tick();
  const mine = feedback('mine', 'obstructed', true); h.calls.at(-1).resolve({ feedback: mine }); await tick();
  check('反馈成功更新本人状态并刷新第一页', h.page.data.myFeedback.kind === 'obstructed' && feedbackCall(h).url.endsWith('limit=5'));
  feedbackCall(h).resolve(feedbackResult([mine, feedback('other')], 'more', mine)); await retry;
  check('成功后解锁并明确反馈未经核实', !h.page.data.feedbackPending && !h.page.data.feedbackActionError && h.toasts.at(-1).includes('未经核实'));
  const withdrawing = h.page.onWithdrawFeedback(); h.page.onWithdrawFeedback(); await tick();
  check('撤回使用DELETE且防重复点击', h.calls.at(-1).method === 'DELETE' && h.page.data.feedbackPending);
  h.calls.at(-1).reject(new Error('撤回失败')); await withdrawing;
  check('撤回失败保留原反馈', h.page.data.myFeedback.id === 'mine' && h.page.data.feedbackItems.some(item => item.id === 'mine'));
  const withdrawRetry = h.page.onFeedbackActionRetry(); await tick(); h.calls.at(-1).resolve({ removed: true }); await tick();
  check('撤回成功立即移除我的旧条目', h.page.data.myFeedback === null && !h.page.data.feedbackItems.some(item => item.isMine));
  feedbackCall(h).resolve(feedbackResult([feedback('other')])); await withdrawRetry;
  check('撤回后重载成功且不遗留选中类型', !h.page.data.feedbackKind && !h.page.data.feedbackPending);
}
{
  const h = await boot(); const mine = feedback('mine', 'still_accessible', true);
  await settle(h, [mine], 'cursor', mine);
  const oldMore = h.page.onFeedbackMore(); const old = feedbackCall(h);
  h.page.onChooseFeedback(choose('location_changed')); const update = h.page.onSubmitFeedback(); await tick();
  const updated = feedback('mine', 'location_changed', true); h.calls.at(-1).resolve({ feedback: updated }); await tick();
  const current = feedbackCall(h); current.resolve(feedbackResult([updated], null, updated)); await update;
  old.resolve(feedbackResult([feedback('stale')], 'stale-cursor', mine)); await oldMore;
  check('提交后旧分页不能覆盖新版反馈、本人状态或游标', h.page.data.feedbackItems.length === 1 && h.page.data.myFeedback.kind === 'location_changed' && !h.page.data.feedbackCursor);
  const reload1 = h.page.loadFeedback(true), first = feedbackCall(h);
  const reload2 = h.page.loadFeedback(true), second = feedbackCall(h);
  second.resolve(feedbackResult([feedback('latest')])); await reload2; first.reject(new Error('旧错误')); await reload1;
  check('旧反馈首页错误不会覆盖新首页成功', h.page.data.feedbackItems[0].id === 'latest' && !h.page.data.feedbackError);
}
{
  const h = await boot(); feedbackCall(h).resolve(feedbackResult()); const oldTime = timeCall(h);
  const selected = h.page.onShootingDateChange(dateEvent('2026-12-21')); const selectedCall = timeCall(h);
  selectedCall.resolve(times('2026-12-21', { blueEvening: null })); await selected;
  oldTime.resolve(times('2026-09-18')); await tick();
  check('日期切换后旧时间响应不得覆盖', h.page.data.shootingDate === '2026-12-21' && h.page.data.shootingRows[5].text === '当日无此时段');
  const before = h.calls.length; await h.page.onShootingDateChange(dateEvent('2101-01-01'));
  check('越界日期不请求接口且保留选择', h.calls.length === before && h.page.data.shootingDate === '2026-12-21');
  const failing = h.page.onShootingDateChange(dateEvent('2026-12-22')); timeCall(h).reject(new Error('计算服务暂不可用')); await failing;
  check('时间错误不误显示无时段、不保留旧日期时段', h.page.data.shootingError === '计算服务暂不可用' && !h.page.data.shootingLoaded && !h.page.data.shootingRows.length);
  const retry = h.page.onShootingRetry(); timeCall(h).resolve(times('2026-12-22')); await retry;
  check('时间失败可以保持日期独立重试', !h.page.data.shootingError && h.page.data.shootingLoaded && h.page.data.shootingDate === '2026-12-22');
}
{
  const h = await boot(); await settle(h);
  const date = '2027-01-01'; const initial = h.page.onShootingDateChange(dateEvent(date)); const old = timeCall(h);
  const oldFeedbackPromise = h.page.loadFeedback(true); const oldFeedback = feedbackCall(h);
  h.page.onEditTap(); h.page.onShow(); await tick(); const newDetail = h.calls.at(-1);
  old.resolve(times(date)); oldFeedback.resolve(feedbackResult([feedback('stale')])); await initial; await oldFeedbackPromise;
  check('编辑返回立即隔离原坐标下的旧工具请求', !h.page.data.feedbackItems.some(item => item.id === 'stale') && !h.page.data.shootingLoaded);
  newDetail.resolve(spot({ lat: 30, lng: 120 })); await tick();
  check('编辑返回保留日期并使用新详情重载工具', h.page.data.shootingDate === date && timeCall(h).url.endsWith(`date=${date}`));
  await settle(h); const more = h.page.loadFeedback(true); const finalFeedback = feedbackCall(h);
  const finalTimePromise = h.page.onShootingRetry(); const finalTime = timeCall(h);
  h.page.onUnload(); finalFeedback.resolve(feedbackResult([feedback('unloaded')])); finalTime.reject(new Error('旧时间错误'));
  await more; await finalTimePromise;
  check('卸载后反馈和时间响应均不写页面', !h.page.data.feedbackItems.some(item => item.id === 'unloaded') && !h.page.data.shootingError);
}
{
  const h = harness({ realRequest: true });
  h.setLogin(() => { h.setUser('owner'); return Promise.resolve({ id: 'owner' }); });
  Object.assign(h.page, { unloaded: false, detailRevision: 0, feedbackRevision: 0, feedbackMutationRevision: 0 });
  h.page.setData({ spot: spot(), loading: false, feedbackKind: 'access_restricted' });
  const pending = h.page.onSubmitFeedback(); await tick(); h.calls.at(-1).respond(401, { error: { code: 'UNAUTHORIZED', message: '已过期' } }); await tick();
  check('反馈写入401沿用自动重登', h.logins.length === 2 && h.logins[1] === true && h.calls.at(-1).header.Authorization === 'Bearer new-token');
  check('过期重登后重放原PUT及kind', h.calls.at(-1).method === 'PUT' && h.calls.at(-1).data.kind === 'access_restricted');
  const mine = feedback('mine', 'access_restricted', true); h.calls.at(-1).respond(200, { data: { feedback: mine } }); await tick();
  h.calls.at(-1).respond(200, { data: feedbackResult([mine], null, mine) }); await pending;
  check('重登恢复后本人反馈状态正确', h.page.data.myFeedback.kind === 'access_restricted' && !h.page.data.feedbackPending);
}
{
  const h = await boot(); const old = feedbackCall(h); h.setUser('other');
  old.resolve(feedbackResult([feedback('old-mine', 'still_accessible', true)], 'old-cursor', feedback('old-mine', 'still_accessible', true)));
  await tick();
  check('GET等待期间换号不展示旧账号本人反馈', h.page.data.myFeedback === null && !h.page.data.feedbackItems.length && !h.page.data.feedbackCursor);
  check('GET换号后自动按新身份刷新且提示重选', feedbackCall(h) !== old && h.page.data.feedbackNotice.includes('账号已变化'));
  feedbackCall(h).resolve(feedbackResult([feedback('new-mine', 'obstructed', true)], null, feedback('new-mine', 'obstructed', true)));
  timeCall(h).resolve(times()); await tick();
  check('换号后只采纳新账号反馈状态', h.page.data.myFeedback.id === 'new-mine');
  h.page.onChooseFeedback(choose('location_changed')); h.setUser('third'); const before = h.calls.length;
  await h.page.onWithdrawFeedback();
  check('显示旧本人记录时换号，撤回不操作新账号', h.calls.length === before + 1 && h.calls.at(-1).method === 'GET' && h.page.data.myFeedback === null);
}
{
  const h = await boot(); await settle(h, [feedback('mine', 'still_accessible', true)], null, feedback('mine', 'still_accessible', true));
  h.page.onChooseFeedback(choose('obstructed')); h.setUser('other'); h.page.onShow();
  check('返回页面发现账号变化立即清空旧选择和本人状态', !h.page.data.feedbackKind && h.page.data.myFeedback === null && !h.page.data.feedbackItems.length);
  await tick(); h.calls.at(-1).resolve(spot()); await tick();
  check('返回页面换号重新请求工具', h.page.data.feedbackLoading && h.page.data.shootingLoading);
  await settle(h);
}
{
  const h = await boot(); await settle(h); const login = deferred(); h.setLogin(() => login.promise);
  h.page.onChooseFeedback(choose('still_accessible')); const write = h.page.onSubmitFeedback(); h.setUser('other'); login.resolve({ id: 'owner' }); await write;
  check('确认登录等待期间换号，取消原操作而不发送PUT', !h.calls.some(call => call.method === 'PUT') && h.page.data.feedbackNotice.includes('账号已变化'));
  check('取消跨号操作后无可重放的旧操作', h.page.lastFeedbackAction === null && !h.page.data.feedbackPending);
  feedbackCall(h).resolve(feedbackResult()); await tick();
}
{
  const h = await boot(); await settle(h); h.page.onChooseFeedback(choose('obstructed'));
  h.setUser('other'); const before = h.calls.length; await h.page.onSubmitFeedback();
  check('已选类型后静默换号，提交入口取消旧选择而不发PUT', h.calls.length === before + 1 && h.calls.at(-1).method === 'GET' && !h.page.data.feedbackKind);
  check('静默前置换号明确提示重新选择', h.page.data.feedbackNotice.includes('重新选择') && h.page.lastFeedbackAction === null);
  feedbackCall(h).resolve(feedbackResult()); await tick();
}
{
  const h = await boot({ initialUser: null }); await settle(h);
  h.setLogin(() => { h.setUser('new-user'); return Promise.resolve({ id: 'new-user' }); });
  h.page.onChooseFeedback(choose('still_accessible')); const pending = h.page.onSubmitFeedback(); await tick();
  check('匿名用户首次正常登录仍可提交本人反馈', h.calls.at(-1).method === 'PUT' && h.calls.at(-1).boundUserId === 'new-user');
  const mine = feedback('new-mine', 'still_accessible', true); h.calls.at(-1).resolve({ feedback: mine }); await tick();
  feedbackCall(h).resolve(feedbackResult([mine], null, mine)); await pending;
}
{
  const h = await boot(); await settle(h); h.page.onChooseFeedback(choose('still_accessible'));
  const pending = h.page.onSubmitFeedback(); await tick(); const oldWrite = h.calls.at(-1); h.setUser('other');
  oldWrite.resolve({ feedback: feedback('old-mine', 'still_accessible', true) }); await pending;
  check('PUT等待期间换号，旧成功不写成新账号本人反馈', h.page.data.myFeedback === null && !h.page.data.feedbackItems.some(item => item.id === 'old-mine'));
  check('旧账号PUT完成后只刷新当前账号，不允许跨号重试', h.page.lastFeedbackAction === null && h.calls.at(-1).method === 'GET');
  feedbackCall(h).resolve(feedbackResult()); await tick();
}
{
  const h = await boot(); await settle(h); h.page.onChooseFeedback(choose('obstructed'));
  const pending = h.page.onSubmitFeedback(); await tick(); h.calls.at(-1).reject(new Error('旧操作失败')); await pending;
  h.setUser('other'); const before = h.calls.length; await h.page.onFeedbackActionRetry();
  check('旧账号失败重试不能对新账号重放写操作', h.calls.length === before + 1 && h.calls.at(-1).method === 'GET' && h.page.lastFeedbackAction === null);
  feedbackCall(h).resolve(feedbackResult()); await tick();
}
{
  const h = harness({ realRequest: true });
  Object.assign(h.page, { unloaded: false, detailRevision: 0, feedbackRevision: 0, feedbackMutationRevision: 0 });
  h.page.setData({ spot: spot(), loading: false, feedbackKind: 'obstructed' });
  h.setLogin(force => { if (force) h.setUser('other'); return Promise.resolve({ id: force ? 'other' : 'owner' }); });
  const pending = h.page.onSubmitFeedback(); await tick(); const oldWrite = h.calls.at(-1);
  check('客户端身份绑定不作为HTTP字段发送', !Object.hasOwn(oldWrite, 'boundUserId') && !Object.hasOwn(oldWrite.data, 'userId'));
  oldWrite.respond(401, { error: { code: 'UNAUTHORIZED' } }); await pending; await tick();
  check('401重登换号后禁止重放旧PUT', h.calls.filter(call => call.method === 'PUT').length === 1);
  check('401换号后清空旧操作并提示重选', h.page.lastFeedbackAction === null && h.page.data.feedbackNotice.includes('账号已变化'));
  h.calls.at(-1).respond(200, { data: feedbackResult() }); await tick();
}
{
  const h = harness({ realRequest: true, fallback: true });
  Object.assign(h.page, { unloaded: false, detailRevision: 0, feedbackRevision: 0, feedbackMutationRevision: 0 });
  h.page.setData({ spot: spot(), loading: false, feedbackKind: 'access_restricted' });
  const pending = h.page.onSubmitFeedback(); await tick(); const oldWrite = h.calls.at(-1); h.setUser('other'); oldWrite.failNetwork(); await pending;
  check('切换网络重试前换号阻止旧PUT重放', h.calls.filter(call => call.method === 'PUT').length === 1 && h.calls.at(-1).method === 'GET');
  h.calls.at(-1).respond(200, { data: feedbackResult() }); await tick();
}
{
  const h = harness({ realRequest: true });
  Object.assign(h.page, { unloaded: false, detailRevision: 0, feedbackRevision: 0, feedbackMutationRevision: 0 });
  h.page.setData({ spot: spot(), loading: false, feedbackKind: 'obstructed' });
  const pending = h.page.onSubmitFeedback(); await tick(); const oldWrite = h.calls.at(-1); h.setUser('other');
  oldWrite.respond(401, { error: { code: 'UNAUTHORIZED' } }); await pending;
  check('旧账号401返回时不清除新账号会话或触发旧操作重登', h.logins.length === 1 && h.page.currentFeedbackUser() === 'other' && h.calls.filter(call => call.method === 'PUT').length === 1);
  h.calls.at(-1).respond(200, { data: feedbackResult() }); await tick();
}
{
  const h = await boot(); const oldFeedback = feedbackCall(h), oldTime = timeCall(h);
  const reloading = h.page.loadDetail(); await tick();
  h.calls.at(-1).reject(new Error('详情刷新失败')); await reloading;
  oldFeedback.resolve(feedbackResult([feedback('stale')])); oldTime.resolve(times()); await tick();
  check('详情刷新失败不遗留被取消工具请求的加载动画', !h.page.data.feedbackLoading && !h.page.data.feedbackMoreLoading && !h.page.data.shootingLoading);
  check('详情刷新失败后旧工具响应仍被隔离', !h.page.data.feedbackItems.length && !h.page.data.shootingLoaded);
}
{
  const h = await boot(); await settle(h); h.page.onChooseFeedback(choose('still_accessible'));
  const pending = h.page.onSubmitFeedback(); await tick(); const write = h.calls.at(-1); h.page.onUnload();
  write.resolve({ feedback: feedback('mine', 'still_accessible', true) }); await pending;
  check('卸载后的写入响应不会触发新刷新或写页面', h.page.data.myFeedback === null && h.calls.at(-1) === write);
}

const template = readFileSync(resolve(root, 'miniprogram/pages/spot/detail.wxml'), 'utf8');
const h = harness();
check('新增模板事件均有对应方法', [...template.matchAll(/(?:bind|catch)\w+="([^"]+)"/g)].every(match => typeof h.page[match[1]] === 'function'));
check('两张卡片都有必要的理论/未经核实提示', template.includes('理论参考') && template.includes('近 30 天') && template.includes('用户反馈未经核实'));
console.log(`\n结果：${passed}/${passed} 项通过`);

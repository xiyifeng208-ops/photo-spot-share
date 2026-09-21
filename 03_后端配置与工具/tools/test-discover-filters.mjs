// Isolated page tests with controlled network completion order; no API writes.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogue = createRequire(import.meta.url)('../miniprogram/data/cities.js');
const format = createRequire(import.meta.url)('../miniprogram/utils/format.js');
const code = readFileSync(resolve(root, 'miniprogram/pages/discover/index.js'), 'utf8');
const delay = ms => new Promise(r => setTimeout(r, ms));
const tick = () => delay(0);
const event = code => ({ currentTarget: { dataset: { code } } });
const input = value => ({ detail: { value } });
const spot = id => ({ id, title: id, createdAt: '2026-09-17T00:00:00Z' });
let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log(`[PASS] ${name}`); }

function harness({ location = null, meta = null } = {}) {
  const calls = [];
  const wx = { stopPullDownRefresh() {}, navigateTo() {} };
  const mocks = {
    '../../utils/request': { request(options) {
      if (options.url.startsWith('/geo/reverse')) return Promise.resolve(meta);
      let success, failure;
      const promise = new Promise((res, rej) => { success = res; failure = rej; });
      calls.push({ url: options.url, params: new URL('http://test' + options.url).searchParams,
        resolve(items = [], nextCursor = '') { success({ items, nextCursor }); },
        reject(message = '网络连接失败') { failure({ message }); } });
      return promise;
    } },
    '../../utils/auth': { ensureLogin: () => Promise.resolve() },
    '../../utils/geo': { getUserLocation: () => Promise.resolve(location) },
    '../../utils/format': { ...format, formatDistance: () => '', formatDate: () => '', buildTags: () => [] },
    '../../data/cities': catalogue
  };
  let page;
  vm.runInNewContext(code, { require: key => mocks[key], Page: p => { page = p; },
    getApp: () => ({ globalData: {} }), wx, setTimeout, clearTimeout });
  page.setData = patch => Object.assign(page.data, patch);
  page.onLoad();
  return { page, calls };
}

check('31 个大陆省级地区', catalogue.provinces.length === 31);
check('城市代码不重复', new Set(catalogue.provinces.flatMap(p => p.cities.map(c => c.code))).size === catalogue.provinces.reduce((n, p) => n + p.cities.length, 0));
check('直辖市只列城市，不误列区县', catalogue.provinces.filter(p => ['110000','120000','310000','500000'].includes(p.code)).every(p => p.cities.length === 1 && p.cities[0].code === p.code));
check('济源、仙桃、石河子按区县字段查询', ['419001','429004','659001'].every(code => catalogue.provinces.some(p => p.cities.some(c => c.code === code && c.field === 'district'))));
check('不列港澳台与普通区县', !catalogue.provinces.some(p => ['710000','810000','820000'].includes(p.code)) && !catalogue.provinces.some(p => p.cities.some(c => c.name === '黄浦区')));

{
  const { page, calls } = harness();
  check('首屏立即请求全部作品', calls.length === 1 && !calls[0].params.has('city'));
  page.onToggleCity();
  check('点击展开城市菜单', page.data.cityPickerOpen);
  page.onCloseCityPicker();
  check('点击外部关闭菜单', !page.data.cityPickerOpen);
  page.onSelectProvince(event('330000'));
  check('省份切换只换选项，不请求作品', calls.length === 1 && page.data.pickerCities.some(c => c.name === '杭州市'));
  page.onSelectCity(event('330100'));
  check('普通城市同时按省和市查询', calls.at(-1).params.get('province') === '浙江省' && calls.at(-1).params.get('city') === '杭州市');
  check('选择后关闭菜单且显示城市', page.data.cityLabel === '杭州市' && !page.data.cityPickerOpen);
  calls.at(-1).resolve([spot('杭州')]); await tick();
  calls[0].resolve([spot('旧全国')]); await tick();
  check('旧首屏结果不覆盖新城市', page.data.spots[0].id === '杭州');
  page.onSelectProvince(event('420000')); page.onSelectCity(event('429004'));
  check('省直辖城市不发送 city 参数', calls.at(-1).params.get('district') === '仙桃市' && calls.at(-1).params.get('province') === '湖北省' && !calls.at(-1).params.has('city'));
  page.onSelectProvince(event('310000')); page.onSelectCity(event('310000'));
  check('上海直辖市筛选', calls.at(-1).params.get('city') === '上海市' && !calls.at(-1).params.has('district'));
  const before = calls.length;
  page.onSearchInput(input('外')); page.onSearchInput(input('  外滩  '));
  check('输入立即使旧结果失效并进入加载状态', page.data.loading && !page.data.spots.length && calls.length === before);
  await delay(350);
  check('连续输入只触发一次去空格搜索', calls.length === before + 1 && calls.at(-1).params.get('keyword') === '外滩');
  check('搜索保留所选城市', calls.at(-1).params.get('city') === '上海市');
  calls.at(-1).resolve([spot('上海外滩')], 'next'); await tick();
  page.loadMore();
  check('下一页携带相同筛选和游标', calls.at(-1).params.get('cursor') === 'next' && calls.at(-1).params.get('keyword') === '外滩');
  const oldNext = calls.at(-1);
  page.onSelectAllCities();
  check('全部城市保留搜索并清除分页和区域', calls.at(-1).params.get('keyword') === '外滩' && !calls.at(-1).params.has('city') && !calls.at(-1).params.has('cursor') && !calls.at(-1).params.has('province'));
  calls.at(-1).resolve([spot('全国外滩')]); await tick();
  oldNext.resolve([spot('旧分页')]); await tick();
  check('旧分页不会混入新列表', page.data.spots.length === 1 && page.data.spots[0].id === '全国外滩');
  page.onSearchInput(input('陆家嘴')); page.onSearchConfirm();
  const confirmedCount = calls.length; await delay(350);
  check('键盘确认立即搜索并取消定时请求', calls.length === confirmedCount && calls.at(-1).params.get('keyword') === '陆家嘴');
  page.onSelectProvince(event('310000')); page.onSelectCity(event('310000')); page.onClearSearch();
  check('清空关键词保留城市', !calls.at(-1).params.has('keyword') && calls.at(-1).params.get('city') === '上海市');
  calls.at(-1).resolve([]); await tick();
  check('空结果正常结束，无错误提示', !page.data.spots.length && page.data.finished && !page.data.loading && !page.data.error);
  page.reload(); calls.at(-1).reject(); await tick();
  check('网络错误与空结果区分', page.data.error === '网络连接失败' && !page.data.loading);
  page.onRetry(); calls.at(-1).resolve([spot('重试成功')], 'more'); await tick();
  check('首屏失败可重试恢复', page.data.spots[0].id === '重试成功' && !page.data.error);
  page.loadMore(); calls.at(-1).reject(); await tick();
  check('下一页失败保留已有列表', page.data.spots[0].id === '重试成功' && page.data.error);
  page.onRetry(); check('下一页重试复用原游标', calls.at(-1).params.get('cursor') === 'more');
  calls.at(-1).resolve([spot('第二页')]); await tick();
  check('重试成功后正确追加', page.data.spots.length === 2 && !page.data.error);
  page.onPullDownRefresh();
  check('刷新保留城市，重置游标', !calls.at(-1).params.has('cursor') && calls.at(-1).params.get('city') === '上海市');
  const beforeUnload = calls.length;
  page.onSearchInput(input('卸载测试')); page.onUnload(); await delay(350);
  check('卸载清理搜索定时器', calls.length === beforeUnload);
  calls.at(-1).resolve([spot('卸载后响应')]); await tick();
  check('卸载后结果不修改页面', page.data.spots.length === 0);
}

{
  let finishLocation;
  const location = new Promise(r => { finishLocation = r; });
  const { page, calls } = harness({ location, meta: { province: '上海市', city: '上海市' } });
  await tick();
  page.onSearchInput(input('外滩'));
  finishLocation({ latitude: 31, longitude: 121 }); await delay(350);
  check('搜索后晚到的定位不覆盖范围', page.data.city === '' && calls.at(-1).params.get('keyword') === '外滩');
  calls[0].reject('旧错误'); await tick();
  check('旧请求报错不影响新请求', !page.data.error && page.data.loading);
  page.onUnload();
}
{
  const { page, calls } = harness({ location: { latitude: 30, longitude: 113 }, meta: { province: '湖北省', city: null, district: '仙桃市' } });
  await tick(); await tick();
  check('省直辖地区自动定位筛选', page.data.cityLabel === '仙桃市' && calls.at(-1).params.get('district') === '仙桃市');
  page.onUnload();
}
{
  const { page, calls } = harness();
  const choose = (field, value) => page.onDraftConditionTap({ currentTarget: { dataset: { field, value } } });
  const remove = (field, value) => page.onRemoveCondition({ currentTarget: { dataset: { field, value } } });
  page.onSelectProvince(event('310000')); page.onSelectCity(event('310000'));
  page.onSearchInput(input('外滩')); page.onSearchConfirm();
  calls.at(-1).resolve([spot('初始')], 'old-next'); await tick();
  page.onToggleCity(); page.onOpenShootingPicker();
  check('条件面板与城市菜单互斥', page.data.shootingPickerOpen && !page.data.cityPickerOpen);
  check('筛选候选复用全部既有枚举', page.data.filterGroups.map(group => group.options.length).join(',') === '7,4,5,3');
  const beforeDraft = calls.length;
  choose('bestTimes', 'night'); choose('bestTimes', 'sunset'); choose('bestSeasons', 'autumn');
  choose('focalLengths', 'tele'); choose('difficulties', '1'); choose('difficulties', '2');
  check('面板多选不立即刷新或改变已选条件', calls.length === beforeDraft && !page.data.shootingFilters.bestTimes.length);
  check('草稿多选按候选顺序排列', page.data.draftFilters.bestTimes.join(',') === 'sunset,night');
  choose('bestTimes', 'invalid'); choose('invalid', 'night');
  check('忽略无效类别和选项', page.data.draftFilters.bestTimes.length === 2);
  page.onCloseShootingPicker(); page.onOpenShootingPicker();
  check('遮罩关闭放弃未确认草稿', !page.data.draftFilters.bestTimes.length && !page.data.selectedConditions.length);
  choose('bestTimes', 'night'); choose('bestTimes', 'sunset'); choose('bestSeasons', 'autumn');
  choose('focalLengths', 'tele'); choose('difficulties', '1'); choose('difficulties', '2');
  page.onConfirmConditions();
  const query = calls.at(-1).params;
  check('确定关闭面板并应用多选 CSV 参数', !page.data.shootingPickerOpen && query.get('bestTimes') === 'sunset,night' && query.get('difficulties') === '1,2');
  check('四组条件与城市关键词组合', query.get('bestSeasons') === 'autumn' && query.get('focalLengths') === 'tele' && query.get('city') === '上海市' && query.get('keyword') === '外滩');
  check('条件变化重置分页并展示摘要', !query.has('cursor') && page.data.selectedConditions.length === 6 && !page.data.spots.length);
  calls.at(-1).resolve([spot('匹配')], 'filtered-next'); await tick(); page.loadMore();
  check('条件分页保留全部参数', calls.at(-1).params.get('cursor') === 'filtered-next' && calls.at(-1).params.get('focalLengths') === 'tele');
  const oldPage = calls.at(-1);
  remove('difficulties', '2');
  check('摘要单项移除只改变对应条件', calls.at(-1).params.get('difficulties') === '1' && calls.at(-1).params.get('bestTimes') === 'sunset,night');
  calls.at(-1).resolve([spot('新条件')]); await tick(); oldPage.resolve([spot('旧条件分页')]); await tick();
  check('旧条件分页结果不混入新列表', page.data.spots.length === 1 && page.data.spots[0].id === '新条件');
  page.onOpenShootingPicker(); const beforeReset = calls.length; page.onResetDraftConditions();
  check('重置只清空草稿且不请求', calls.length === beforeReset && !page.data.draftFilters.bestTimes.length && page.data.shootingFilters.bestTimes.length === 2);
  page.onCloseShootingPicker(); page.onOpenShootingPicker();
  check('重置后取消保留已应用筛选', page.data.draftFilters.bestTimes.length === 2);
  page.onResetDraftConditions(); page.onConfirmConditions();
  check('重置后确定清除全部拍摄条件而保留城市关键词', !calls.at(-1).params.has('bestTimes') && !calls.at(-1).params.has('difficulties') && calls.at(-1).params.get('keyword') === '外滩' && calls.at(-1).params.get('city') === '上海市');
  page.onOpenShootingPicker(); choose('bestTimes', 'night'); page.onConfirmConditions();
  page.onPullDownRefresh();
  check('下拉刷新沿用拍摄条件', calls.at(-1).params.get('bestTimes') === 'night' && !calls.at(-1).params.has('cursor'));
  page.onClearSearch();
  check('清空关键词不清空拍摄条件', calls.at(-1).params.get('bestTimes') === 'night' && !calls.at(-1).params.has('keyword'));
  page.onSelectAllCities();
  check('切换全部城市不清空拍摄条件', calls.at(-1).params.get('bestTimes') === 'night' && !calls.at(-1).params.has('province'));
  page.onClearConditions();
  check('空结果清空条件入口可恢复不限条件', !calls.at(-1).params.has('bestTimes') && !page.data.selectedConditions.length);
  page.onOpenShootingPicker(); page.onToggleCity();
  check('打开城市菜单关闭条件面板', page.data.cityPickerOpen && !page.data.shootingPickerOpen);
  page.onUnload();
}
{
  let finishLocation;
  const location = new Promise(resolve => { finishLocation = resolve; });
  const { page, calls } = harness({ location, meta: { province: '上海市', city: '上海市' } });
  await tick(); page.onOpenShootingPicker();
  finishLocation({ latitude: 31, longitude: 121 }); await tick(); await tick();
  check('操作条件面板后延迟定位不能改变城市', page.data.city === '' && calls.length === 1);
  page.onUnload();
}
console.log(`\n结果：${passed}/${passed} 项通过`);

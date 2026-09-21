#!/usr/bin/env node
// Pure in-memory Mini Program FS, UI and API regression: never touches daily data.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MINI = resolve(ROOT, 'miniprogram');
const req = createRequire(resolve(MINI, 'app.js'));
const clone = value => JSON.parse(JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let passed = 0;
async function test(name, action) { await action(); passed++; console.log(`[PASS] ${name}`); }

function environment() {
  const state = { files: new Map(), storage: new Map(), dirs: new Set(), calls: [], ui: [], user: { id: 'account-a' },
    modalConfirm: true, actionChoice: 2, copyFailure: false, storageFailure: false, unlinkFailure: false,
    location: null, center: { latitude: 30.2, longitude: 120.1 }, requests: [], reverse: { configured: false }, submitFailure: false };
  function call(method, options, action) {
    state.calls.push(method);
    try { options.success(action()); } catch (error) { options.fail({ errMsg: error.message }); }
  }
  const fs = {
    access: options => call('access', options, () => { if (!state.dirs.has(options.path) && !state.files.has(options.path)) throw Error('not found'); return {}; }),
    mkdir: options => call('mkdir', options, () => { state.dirs.add(options.dirPath); return {}; }),
    readdir: options => call('readdir', options, () => {
      if (!state.dirs.has(options.dirPath)) throw Error('not found');
      return { files: [...state.files.keys()].filter(path => path.startsWith(`${options.dirPath}/`)).map(path => path.slice(options.dirPath.length + 1)) };
    }),
    stat: options => call('stat', options, () => {
      if (!state.files.has(options.path)) throw Error('photo missing');
      return { stats: { size: state.files.get(options.path) } };
    }),
    copyFile: options => {
      const copy = () => call('copyFile', options, () => {
        if (state.copyFailure) throw Error('disk full');
        if (!state.files.has(options.srcPath)) throw Error('source missing');
        state.files.set(options.destPath, state.files.get(options.srcPath)); return {};
      });
      if (state.copyGate) state.copyGate.promise.then(copy); else copy();
    },
    unlink: options => call('unlink', options, () => { if (state.unlinkFailure) throw Error('busy'); state.files.delete(options.filePath); return {}; })
  };
  const wx = {
    env: { USER_DATA_PATH: '/wx-user' }, getFileSystemManager: () => fs,
    getStorageSync: key => clone(state.storage.get(key) || ''),
    setStorageSync: (key, value) => { if (state.storageFailure) throw Error('storage full'); state.storage.set(key, clone(value)); },
    createMapContext: () => ({}),
    showToast: value => state.ui.push({ type: 'toast', ...value }), showLoading() {}, hideLoading() {},
    setNavigationBarTitle() {}, previewImage() {}, stopPullDownRefresh() {},
    navigateBack: value => state.ui.push({ type: 'back', ...value }),
    navigateTo: value => state.ui.push({ type: 'navigate', ...value }),
    redirectTo: value => state.ui.push({ type: 'redirect', ...value }),
    showActionSheet: options => { state.ui.push({ type: 'sheet' }); if (state.actionChoice < 0) options.fail({}); else options.success({ tapIndex: state.actionChoice }); },
    showModal: options => { state.ui.push({ type: 'modal', title: options.title }); if (options.success) return options.success({ confirm: state.modalConfirm }); },
    chooseMedia: options => options.success({ tempFiles: (state.chooseFiles || []).map(tempFilePath => ({ tempFilePath })) })
  };
  const auth = { ensureLogin: async () => { if (state.authFailure) throw Error('offline'); return state.user; }, currentUser: () => state.user };
  const geo = { getUserLocation: async () => state.locationGate ? state.locationGate.promise : state.location,
    getCenterLocation: async () => { if (state.centerFailure) throw Error('map unmounted'); return state.centerGate ? state.centerGate.promise : state.center; },
    openLocationSetting: async () => false };
  const request = async options => {
    state.requests.push(clone(options));
    if (options.url.startsWith('/geo/')) return state.reverseGate ? state.reverseGate.promise : state.reverse;
    if (options.method === 'POST' || options.method === 'PATCH') {
      if (state.submitFailure) throw Error('network offline');
      return state.submitGate ? state.submitGate.promise : { id: 'saved-spot', status: 'active' };
    }
    if (state.editFailure) throw Error('load offline');
    return state.spot || { id: 'edit-spot', lat: 31, lng: 121, title: '原有作品', photos: [{ key: 'photo-key', url: 'https://sample/image.jpg' }] };
  };
  const timers = new Set();
  function load(relative, dependencies = {}) {
    let page;
    const module = { exports: {} };
    const file = resolve(MINI, relative);
    const localRequire = createRequire(file);
    const context = { module, exports: module.exports, wx, console, Date, Math, Promise, Set, Map,
      setTimeout: (callback, delay) => { const id = setTimeout(() => { timers.delete(id); callback(); }, delay); timers.add(id); return id; },
      clearTimeout: id => { clearTimeout(id); timers.delete(id); },
      Page: value => { page = value; },
      require: name => dependencies[name] || localRequire(name)
    };
    vm.runInNewContext(readFileSync(file, 'utf8'), context, { filename: file });
    if (page) {
      const instance = { ...page, data: clone(page.data) };
      instance.setData = function(patch, callback) { Object.assign(this.data, patch); if (callback) callback(); };
      return instance;
    }
    return module.exports;
  }
  const drafts = load('utils/drafts.js');
  const dependencies = { '../../utils/drafts': drafts, '../../utils/auth': auth, '../../utils/geo': geo,
    '../../utils/request': { request }, '../../utils/upload': { uploadPhotos: async paths => ({ keys: paths.map((_, index) => `uploaded-${index}`) }) } };
  const page = () => load('pages/spot/create.js', dependencies);
  const listPage = () => load('pages/drafts/index.js', dependencies);
  const cleanup = () => { timers.forEach(clearTimeout); timers.clear(); };
  return { state, wx, drafts, page, listPage, cleanup };
}
const region = req('./utils/publish-region.js');
const fields = { title: '测试机位', description: '说明', latitude: 31.2, longitude: 121.5, addressInput: '详细地址',
  geoMeta: { province: '上海市', city: '上海市', district: '黄浦区' }, bestTimes: ['night'], bestSeasons: [],
  difficulty: null, step: 2, photos: [], agreed: true, uploadTickets: ['private'] };
const edit = (page, field, value) => page.onInput({ currentTarget: { dataset: { field } }, detail: { value } });
const photoFiles = state => [...state.files.keys()].filter(path => path.startsWith('/wx-user/'));
const make = async env => { const page = env.page(); await page.onLoad({ fresh: '1' }); return page; };
const chooseShanghai = page => page.onChooseRegion({ detail: { value: region.indicesFor({ province: '上海市', city: '上海市' }) } });
async function ready(env, page) {
  chooseShanghai(page); edit(page, 'title', '发布测试机位'); edit(page, 'addressInput', '中山东一路');
  env.state.files.set('/tmp/one.jpg', 100); env.state.chooseFiles = ['/tmp/one.jpg']; page.onChoosePhoto();
  page.setData({ agreed: true }); await page.flushDraft();
}

await test('直辖市缺少 city 时按目录补全', () => assert.equal(region.normalize({ province: '上海市', city: null }).city, '上海市'));
await test('普通省份不凭标题猜城市', () => assert.equal(region.normalize({ province: '浙江省', address: '杭州市' }), null));
await test('省直辖地区保持 city 空、district 正确', () => {
  const value = region.normalize({ province: '湖北省', city: '', district: '仙桃市' });
  assert.equal(value.city, null); assert.equal(value.district, '仙桃市');
});
await test('手选不同城市不携带旧区县', () => {
  const value = region.fromIndices(region.indicesFor({ province: '浙江省', city: '杭州市', district: '黄浦区' }));
  assert.equal(value.district, null);
});
await test('目录范围外地区无法冒充有效省市', () => assert.equal(region.normalize({ province: '不存在省', city: '上海市' }), null));

await test('草稿照片持久化后才提交索引，保持照片顺序', async () => {
  const e = environment(); e.state.files.set('/tmp/a.jpg', 11); e.state.files.set('/tmp/b.png', 22);
  const saved = await e.drafts.save('account-a', 'draft-photo-1', { ...fields, photos: [{ tempPath: '/tmp/b.png' }, { tempPath: '/tmp/a.jpg' }] });
  assert.deepEqual(clone(saved.photos.map(p => p.size)), [22, 11]); assert.equal(photoFiles(e.state).length, 2);
  assert(saved.photos.every(p => p.path.startsWith('/wx-user/spot-drafts-v1/')));
  assert(e.state.files.has('/tmp/a.jpg')); e.cleanup();
});
await test('草稿只保存白名单字段，不含协议、令牌、上传票据', async () => {
  const e = environment(); const saved = await e.drafts.save('account-a', 'draft-private', { ...fields, token: 'secret', photoKeys: ['key'] });
  assert(!('agreed' in saved)); assert(!('token' in saved)); assert(!('uploadTickets' in saved)); assert(!('photoKeys' in saved)); e.cleanup();
});
await test('同一草稿再次保存复用已持久化照片', async () => {
  const e = environment(); e.state.files.set('/tmp/a.jpg', 10);
  await e.drafts.save('account-a', 'draft-repeat', { ...fields, photos: [{ tempPath: '/tmp/a.jpg' }] });
  const loaded = await e.drafts.load('account-a', 'draft-repeat');
  await e.drafts.save('account-a', 'draft-repeat', { ...loaded, title: '新标题' });
  assert.equal(photoFiles(e.state).length, 1); assert.equal((await e.drafts.list('account-a')).length, 1); e.cleanup();
});
await test('不同账号草稿隔离且拒绝读取他人编号', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-private', fields);
  assert.equal((await e.drafts.list('account-b')).length, 0);
  await assert.rejects(e.drafts.load('account-b', 'draft-private'), /不属于/); e.cleanup();
});
await test('同一账号最多10份，不淘汰旧稿；其他账号仍可保存', async () => {
  const e = environment(); for (let i = 0; i < 10; i++) await e.drafts.save('account-a', `draft-limit-${i}`, fields);
  await assert.rejects(e.drafts.save('account-a', 'draft-limit-new', fields), /10 份/);
  assert.equal((await e.drafts.list('account-a')).length, 10);
  await e.drafts.save('account-b', 'draft-limit-new', fields); assert.equal((await e.drafts.list('account-b')).length, 1); e.cleanup();
});
await test('100MB图片上限按所有账号合计计算', async () => {
  const e = environment(); e.state.files.set('/tmp/full.jpg', e.drafts.MAX_PHOTO_BYTES); e.state.files.set('/tmp/one.jpg', 1);
  await e.drafts.save('account-a', 'draft-full-size', { ...fields, photos: [{ tempPath: '/tmp/full.jpg' }] });
  await assert.rejects(e.drafts.save('account-b', 'draft-one-byte', { ...fields, photos: [{ tempPath: '/tmp/one.jpg' }] }), /100 MB/);
  assert.equal((await e.drafts.list('account-a')).length, 1); assert.equal((await e.drafts.list('account-b')).length, 0); e.cleanup();
});
await test('复制失败时保留原草稿，不显示新内容已保存', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-copy-fail', fields); e.state.files.set('/tmp/a.jpg', 1); e.state.copyFailure = true;
  await assert.rejects(e.drafts.save('account-a', 'draft-copy-fail', { ...fields, title: '未保存', photos: [{ tempPath: '/tmp/a.jpg' }] }), /disk full/);
  assert.equal((await e.drafts.load('account-a', 'draft-copy-fail')).title, fields.title); e.cleanup();
});
await test('索引写入失败回滚新照片，保留原索引', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-index-fail', fields); e.state.files.set('/tmp/a.jpg', 1); e.state.storageFailure = true;
  await assert.rejects(e.drafts.save('account-a', 'draft-index-fail', { ...fields, photos: [{ tempPath: '/tmp/a.jpg' }] }), /storage full/);
  assert.equal(photoFiles(e.state).length, 0); assert.equal((await e.drafts.list('account-a'))[0].photos.length, 0); e.cleanup();
});
await test('恢复时缺失图片仅移除失效引用，文字保留', async () => {
  const e = environment(); e.state.files.set('/tmp/a.jpg', 1);
  const saved = await e.drafts.save('account-a', 'draft-missing-photo', { ...fields, photos: [{ tempPath: '/tmp/a.jpg' }] });
  e.state.files.delete(saved.photos[0].path); const restored = await e.drafts.load('account-a', saved.id);
  assert.equal(restored.title, fields.title); assert.equal(restored.missingPhotos, 1); assert.equal(restored.photos.length, 0); e.cleanup();
});
await test('删除草稿只删除其自有照片，不删除其他账号/临时源图', async () => {
  const e = environment(); e.state.files.set('/tmp/a.jpg', 1);
  await e.drafts.save('account-a', 'draft-delete-a', { ...fields, photos: [{ tempPath: '/tmp/a.jpg' }] });
  await e.drafts.save('account-b', 'draft-delete-b', { ...fields, photos: [{ tempPath: '/tmp/a.jpg' }] });
  await e.drafts.remove('account-a', 'draft-delete-a');
  assert.equal(photoFiles(e.state).length, 1); assert.equal((await e.drafts.list('account-b')).length, 1); assert(e.state.files.has('/tmp/a.jpg')); e.cleanup();
});
await test('拒绝路径形式的草稿编号与缺失账号', async () => {
  const e = environment(); await assert.rejects(e.drafts.save('account-a', '../../bad', fields), /无效/);
  await assert.rejects(e.drafts.list(null), /账号/); e.cleanup();
});
await test('删除时文件暂忙后可重新清理，不永久占满100MB', async () => {
  const e = environment(); e.state.files.set('/tmp/a.jpg', e.drafts.MAX_PHOTO_BYTES);
  await e.drafts.save('account-a', 'draft-orphan-full', { ...fields, photos: [{ tempPath: '/tmp/a.jpg' }] });
  e.state.unlinkFailure = true; const result = await e.drafts.remove('account-a', 'draft-orphan-full'); assert.equal(result.cleanupPending, 1);
  e.state.unlinkFailure = false; e.state.files.set('/tmp/b.jpg', 1);
  await e.drafts.save('account-a', 'draft-orphan-new', { ...fields, photos: [{ tempPath: '/tmp/b.jpg' }] });
  assert.equal(photoFiles(e.state).length, 1); e.cleanup();
});
await test('仅清理本模块命名孤儿照片，不删除其他文件', async () => {
  const e = environment(); e.state.dirs.add('/wx-user/spot-drafts-v1');
  e.state.files.set('/wx-user/spot-drafts-v1/account-a_draft-dead-photo_abc-def.jpg', 1);
  e.state.files.set('/wx-user/spot-drafts-v1/user-notes.txt', 1);
  await e.drafts.list('account-a'); assert(!e.state.files.has('/wx-user/spot-drafts-v1/account-a_draft-dead-photo_abc-def.jpg'));
  assert(e.state.files.has('/wx-user/spot-drafts-v1/user-notes.txt')); e.cleanup();
});
await test('草稿索引损坏时停止且不清理任何照片', async () => {
  const e = environment(); e.state.storage.set('spot.publish-drafts.v1', { version: 1, users: { a: 'bad' } });
  await assert.rejects(e.drafts.list('account-a'), /索引异常/); assert(!e.state.calls.includes('unlink')); e.cleanup();
});
await test('并发保存串行提交，后一次内容最终生效', async () => {
  const e = environment(); await Promise.all([e.drafts.save('account-a', 'draft-serialized', fields),
    e.drafts.save('account-a', 'draft-serialized', { ...fields, title: '最新' })]);
  assert.equal((await e.drafts.load('account-a', 'draft-serialized')).title, '最新'); e.cleanup();
});
await test('复制期间取消保存会回滚文件且不写索引', async () => {
  const e = environment(); e.state.files.set('/tmp/a.jpg', 1); e.state.copyGate = deferred(); let active = true;
  const saving = e.drafts.save('account-a', 'draft-cancel-copy', { ...fields, photos: [{ tempPath: '/tmp/a.jpg' }] }, { isCurrent: () => active });
  await wait(0); active = false; e.state.copyGate.resolve(); assert.equal(await saving, null);
  assert.equal((await e.drafts.list('account-a')).length, 0); assert.equal(photoFiles(e.state).length, 0); e.cleanup();
});
await test('不把上传票据或远程图片误当作本机草稿照片', async () => {
  const e = environment(); await assert.rejects(e.drafts.save('account-a', 'draft-remote-key', { ...fields, photos: [{ key: 'uploaded', url: 'https://image' }] }), /本地文件/); e.cleanup();
});

await test('新发布默认未知难度，自动定位不生成空草稿', async () => {
  const e = environment(); const page = await make(e); assert.equal(page.data.difficulty, null);
  assert.equal((await e.drafts.list('account-a')).length, 0); assert.equal(page.data.draftId, ''); e.cleanup();
});
await test('输入停止500ms自动保存，无需手动点击', async () => {
  const e = environment(); const page = await make(e); edit(page, 'title', '自动保存');
  await wait(550); assert.equal((await e.drafts.list('account-a'))[0].title, '自动保存'); assert.match(page.data.draftStatus, /已保存/); e.cleanup();
});
await test('onHide立即补存最后输入，步骤同时保存', async () => {
  const e = environment(); const page = await make(e); edit(page, 'description', '离开前最后一句'); await page.onNextStep(); page.onHide();
  await page.draftSavePromise; const saved = (await e.drafts.list('account-a'))[0];
  assert.equal(saved.description, '离开前最后一句'); assert.equal(saved.step, 2); e.cleanup();
});
await test('照片真正持久化前不显示已保存', async () => {
  const e = environment(); const page = await make(e); e.state.files.set('/tmp/a.jpg', 12); e.state.chooseFiles = ['/tmp/a.jpg']; e.state.copyGate = deferred();
  page.onChoosePhoto(); const save = page.flushDraft(); await wait(0); assert.match(page.data.draftStatus, /正在保存/);
  assert.equal(e.state.storage.size, 0); e.state.copyGate.resolve(); await save; assert.match(page.data.draftStatus, /已保存/); e.cleanup();
});
await test('慢照片保存期间再输入不会被旧快照覆盖，最后一次修改自动补存', async () => {
  const e = environment(); const page = await make(e); e.state.files.set('/tmp/a.jpg', 12); e.state.chooseFiles = ['/tmp/a.jpg']; e.state.copyGate = deferred();
  page.onChoosePhoto(); const save = page.flushDraft(); await wait(0); edit(page, 'title', '复制期间编辑的新标题');
  e.state.copyGate.resolve(); await save; assert.equal((await e.drafts.list('account-a'))[0].title, '复制期间编辑的新标题');
  assert.equal(photoFiles(e.state).length, 1); e.cleanup();
});
await test('卸载时仍完成排队保存，后续恢复图片有效', async () => {
  const e = environment(); const page = await make(e); e.state.files.set('/tmp/a.jpg', 12); e.state.chooseFiles = ['/tmp/a.jpg']; page.onChoosePhoto();
  page.onUnload(); await page.draftSavePromise; const restored = await e.drafts.load('account-a', page.data.draftId);
  assert.equal(restored.photos.length, 1); assert.equal(restored.missingPhotos, 0); e.cleanup();
});
await test('草稿恢复保留步骤地区和图片，协议需重新勾选，不再次定位', async () => {
  const e = environment(); e.state.files.set('/tmp/a.jpg', 1);
  await e.drafts.save('account-a', 'draft-resume-test', { ...fields, photos: [{ tempPath: '/tmp/a.jpg' }] });
  e.state.location = { latitude: 0, longitude: 0 }; const page = e.page(); await page.onLoad({ draftId: 'draft-resume-test' });
  assert.equal(page.data.latitude, fields.latitude); assert.equal(page.data.step, 2); assert.equal(page.data.agreed, false);
  assert.equal(page.data.photos.length, 1); assert.equal(e.state.requests.length, 0); e.cleanup();
});
await test('已有草稿新建入口可继续最近一份', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-choice-resume', fields); e.state.actionChoice = 0;
  const page = e.page(); await page.onLoad({}); assert.equal(page.data.title, fields.title); assert.equal(page.data.draftId, 'draft-choice-resume'); e.cleanup();
});
await test('已有草稿入口可跳转草稿箱', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-choice-box', fields); e.state.actionChoice = 1;
  const page = e.page(); await page.onLoad({}); assert(e.state.ui.some(item => item.type === 'redirect' && item.url === '/pages/drafts/index')); e.cleanup();
});
await test('选择新建不会覆盖已有草稿', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-choice-new', fields); e.state.actionChoice = 2;
  const page = e.page(); await page.onLoad({}); edit(page, 'title', '新的草稿'); await page.flushDraft();
  assert.equal((await e.drafts.list('account-a')).length, 2); e.cleanup();
});
await test('取消新建选择返回，不后台新建草稿', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-choice-cancel', fields); e.state.actionChoice = -1;
  const page = e.page(); await page.onLoad({}); assert(e.state.ui.some(item => item.type === 'back')); assert.equal(page.data.draftId, ''); e.cleanup();
});
await test('草稿恢复失败阻止发布，不静默改成新建', async () => {
  const e = environment(); const page = e.page(); await page.onLoad({ draftId: 'draft-not-found' });
  page.setData({ ...fields, photos: [{ key: 'key' }], agreed: true }); await page.onSubmit();
  assert.equal(page.restoreFailed, true); assert.equal(e.state.requests.filter(item => item.method === 'POST').length, 0); e.cleanup();
});
await test('开始填写后延迟定位不能覆盖用户位置', async () => {
  const e = environment(); e.state.locationGate = deferred(); const page = e.page(); const loading = page.onLoad({ fresh: '1' });
  await wait(0); chooseShanghai(page); edit(page, 'addressInput', '自己的地址');
  e.state.locationGate.resolve({ latitude: 0, longitude: 0 }); await loading; assert.notEqual(page.data.latitude, 0); assert.equal(page.data.geoMeta.city, '上海市'); e.cleanup();
});
await test('旧逆地址响应不覆盖手写地址，但可补全尚未选择的地区', async () => {
  const e = environment(); const page = await make(e); e.state.reverseGate = deferred(); const resolving = page.reverseGeocodeAt(31, 121);
  edit(page, 'addressInput', '手写地址'); e.state.reverseGate.resolve({ configured: true, province: '上海市', city: null, address: '旧地址' }); await resolving;
  assert.equal(page.data.addressInput, '手写地址'); assert.equal(page.data.geoMeta.city, '上海市'); e.cleanup();
});
await test('旧逆地址响应不覆盖手选地区', async () => {
  const e = environment(); const page = await make(e); e.state.reverseGate = deferred(); const resolving = page.reverseGeocodeAt(30, 120);
  chooseShanghai(page); e.state.reverseGate.resolve({ configured: true, province: '浙江省', city: '杭州市', address: '旧地址' }); await resolving;
  assert.equal(page.data.geoMeta.city, '上海市'); e.cleanup();
});
await test('新点逆地址失败清空旧地区，需要用户确认', async () => {
  const e = environment(); const page = await make(e); chooseShanghai(page); await page.reverseGeocodeAt(20, 110);
  assert.equal(page.data.geoMeta, null); assert.match(page.data.regionLabel, /请选择/); e.cleanup();
});
await test('拖动后立即下一步也提交新地图中心，不读已卸载地图', async () => {
  const e = environment(); const page = await make(e); e.state.reverse = { configured: true, province: '浙江省', city: '杭州市', address: '新点地址' };
  e.state.centerGate = deferred(); page.onRegionChange({ type: 'end', causedBy: 'drag' }); const next = page.onNextStep();
  assert.equal(page.data.step, 1); e.state.centerGate.resolve({ latitude: 30.22, longitude: 120.11 }); await next; await wait(0);
  assert.equal(page.data.step, 2); assert.equal(page.data.latitude, 30.22); assert.equal(page.data.longitude, 120.11);
  assert.equal(page.data.geoMeta.city, '杭州市'); e.cleanup();
});
await test('地图中心读取失败时禁止发布旧坐标', async () => {
  const e = environment(); const page = await make(e); e.state.centerFailure = true;
  await page.onRegionChange({ type: 'end', causedBy: 'drag' }); await page.onNextStep(); assert.equal(page.data.step, 1); assert.equal(page.pointFailed, true); e.cleanup();
});
await test('程序自身更新地图不覆盖已恢复地区', async () => {
  const e = environment(); const page = await make(e); chooseShanghai(page);
  page.onRegionChange({ type: 'end', causedBy: 'update' }); assert.equal(page.data.geoMeta.city, '上海市'); e.cleanup();
});
await test('手选地区取消旧地址定时器，下一步不会重新执行已取消请求', async () => {
  const e = environment(); const page = await make(e);
  await page.onRegionChange({ type: 'end', causedBy: 'drag' });
  chooseShanghai(page); const before = e.state.requests.length; await page.onNextStep(); await wait(0);
  assert.equal(e.state.requests.length, before); assert.equal(page.data.geoMeta.city, '上海市'); e.cleanup();
});
await test('新发布必须明确地区，手填地址不推断城市', async () => {
  const e = environment(); const page = await make(e); page.setData({ ...fields, geoMeta: null, photos: [{ key: 'key' }] });
  await page.onSubmit(); assert.equal(e.state.requests.filter(item => item.method === 'POST').length, 0); assert(e.state.ui.some(item => /省份/.test(item.title || ''))); e.cleanup();
});
await test('新发布必须填写详细地址', async () => {
  const e = environment(); const page = await make(e); page.setData({ ...fields, addressInput: '', photos: [{ key: 'key' }] });
  await page.onSubmit(); assert.equal(e.state.requests.filter(item => item.method === 'POST').length, 0); e.cleanup();
});
await test('编辑清空标签时显式发 [] / null，未知难度保持null', async () => {
  const e = environment(); const page = e.page(); await page.onLoad({ id: 'edit-spot' });
  page.setData({ bestTimes: [], bestSeasons: [], heading: '', focalLength: '', accessNote: '', difficulty: null }); await page.onSubmit();
  const data = e.state.requests.find(item => item.method === 'PATCH').data;
  assert.deepEqual(data.bestTimes, []); assert.deepEqual(data.bestSeasons, []);
  assert.equal(data.heading, null); assert.equal(data.focalLength, null); assert.equal(data.accessNote, null); assert.equal(data.difficulty, null); e.cleanup();
});
await test('未修改历史不完整位置时省略geo和坐标，允许仅编辑文字', async () => {
  const e = environment(); const page = e.page(); await page.onLoad({ id: 'edit-spot' }); edit(page, 'title', '只改作品标题'); await page.onSubmit();
  const data = e.state.requests.find(item => item.method === 'PATCH').data; assert(!('geo' in data)); assert(!('lat' in data));
  assert.equal((await e.drafts.list('account-a')).length, 0); e.cleanup();
});
await test('编辑加载失败禁止空表单覆盖原信息，重试可恢复', async () => {
  const e = environment(); e.state.editFailure = true; const page = e.page(); await page.onLoad({ id: 'edit-spot' });
  page.setData({ ...fields, photos: [{ key: 'key' }] }); await page.onSubmit(); assert.equal(e.state.requests.filter(item => item.method === 'PATCH').length, 0);
  e.state.editFailure = false; await page.onRetryEdit(); assert.equal(page.data.editLoadError, false); assert.equal(page.data.title, '原有作品'); e.cleanup();
});
await test('发布失败保留本机草稿与照片', async () => {
  const e = environment(); const page = await make(e); await ready(e, page); e.state.submitFailure = true; await page.onSubmit();
  assert.equal((await e.drafts.list('account-a')).length, 1); assert.equal(photoFiles(e.state).length, 1); assert.equal(page.published, false); e.cleanup();
});
await test('发布成功后删除草稿及照片，隐藏/卸载/待执行保存不能复活', async () => {
  const e = environment(); const page = await make(e); await ready(e, page); edit(page, 'title', '最后修改'); await page.onSubmit();
  page.onHide(); page.onUnload(); await wait(550);
  assert.equal((await e.drafts.list('account-a')).length, 0); assert.equal(photoFiles(e.state).length, 0); assert.equal(page.published, true); e.cleanup();
});
await test('发布已确认后再次点击不会重复创建', async () => {
  const e = environment(); const page = await make(e); await ready(e, page); await page.onSubmit(); await page.onSubmit();
  assert.equal(e.state.requests.filter(item => item.method === 'POST').length, 1); e.cleanup();
});
await test('保存失败时明确提示，不把草稿标成已保存', async () => {
  const e = environment(); const page = await make(e); edit(page, 'title', '无法保存'); e.state.storageFailure = true;
  await page.onSaveDraft(); assert.match(page.data.draftStatus, /保存失败/); assert.equal(page.savedVersion, 0); e.cleanup();
});
await test('无法确定账号不保存到公共草稿空间，用户可重试', async () => {
  const e = environment(); e.state.user = null; const page = await make(e); edit(page, 'title', '未登录草稿'); await page.onSaveDraft();
  assert.match(page.data.draftStatus, /账号/); assert.equal(e.state.storage.size, 0);
  e.state.user = { id: 'account-a' }; await page.onSaveDraft(); assert.equal((await e.drafts.list('account-a')).length, 1); e.cleanup();
});
await test('复制期间切换账号阻止提交草稿到旧账号', async () => {
  const e = environment(); const page = await make(e); e.state.files.set('/tmp/a.jpg', 12); e.state.chooseFiles = ['/tmp/a.jpg']; e.state.copyGate = deferred();
  page.onChoosePhoto(); const save = page.flushDraft(); await wait(0); e.state.user = { id: 'account-b' }; e.state.copyGate.resolve();
  await assert.rejects(save, /账号已变化/); assert.equal((await e.drafts.list('account-a')).length, 0); assert.equal(photoFiles(e.state).length, 0); e.cleanup();
});
await test('从发布页进入草稿箱替换旧页，避免删除后回到失效编辑器', async () => {
  const e = environment(); const page = await make(e); edit(page, 'title', '去草稿箱前保存'); await page.onOpenDrafts();
  assert(e.state.ui.some(item => item.type === 'redirect' && item.url === '/pages/drafts/index'));
  assert.equal((await e.drafts.list('account-a'))[0].title, '去草稿箱前保存'); e.cleanup();
});
await test('草稿箱加载显示标题时间封面，继续编辑指向对应编号', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-list-resume', fields);
  const list = e.listPage(); list.onLoad(); await list.onShow(); assert.equal(list.data.items[0].title, fields.title);
  list.onResume({ currentTarget: { dataset: { id: 'draft-list-resume' } } });
  assert(e.state.ui.some(item => /draftId=draft-list-resume/.test(item.url || ''))); e.cleanup();
});
await test('草稿箱删除需确认，取消不删除', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-list-cancel', fields);
  const list = e.listPage(); list.onLoad(); await list.onShow(); e.state.modalConfirm = false;
  list.onDelete({ currentTarget: { dataset: { id: 'draft-list-cancel', title: fields.title } } }); await wait(0);
  assert.equal((await e.drafts.list('account-a')).length, 1); e.cleanup();
});
await test('草稿箱确认删除后刷新为空', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-list-delete', fields);
  const list = e.listPage(); list.onLoad(); await list.onShow();
  list.onDelete({ currentTarget: { dataset: { id: 'draft-list-delete', title: fields.title } } }); await wait(10);
  assert.equal(list.data.items.length, 0); assert.equal((await e.drafts.list('account-a')).length, 0); e.cleanup();
});
await test('草稿箱失败显示重试而非空状态', async () => {
  const e = environment(); e.state.authFailure = true; const list = e.listPage(); list.onLoad(); await list.onShow(); assert.match(list.data.error, /offline/);
  e.state.authFailure = false; await list.reload(); assert.equal(list.data.error, ''); e.cleanup();
});
await test('草稿箱账号切换后不能继续旧账号草稿', async () => {
  const e = environment(); await e.drafts.save('account-a', 'draft-list-account', fields);
  const list = e.listPage(); list.onLoad(); await list.onShow(); e.state.user = { id: 'account-b' };
  list.onResume({ currentTarget: { dataset: { id: 'draft-list-account' } } }); await wait(0);
  assert(!e.state.ui.some(item => item.type === 'navigate')); assert.equal(list.data.items.length, 0); e.cleanup();
});

console.log(`\nPublish metadata/drafts regression: ${passed}/${passed} passed`);

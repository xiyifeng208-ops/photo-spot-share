// Local-only drafts. The global queue serializes files + manifest across pages/accounts.
// Commit metadata only after every photo is durable; never save upload keys or consent.
const STORAGE_KEY = 'spot.publish-drafts.v1';
const MAX_DRAFTS = 10;
const MAX_PHOTO_BYTES = 100 * 1024 * 1024;
let queue = Promise.resolve();
const run = operation => {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
};
const clone = value => JSON.parse(JSON.stringify(value));
function ownerKey(userId) {
  if (!userId || typeof userId !== 'string') throw new Error('无法确定当前账号，尚不能保存草稿');
  return `user:${userId}`;
}
function readManifest() {
  const value = wx.getStorageSync(STORAGE_KEY);
  if (!value) return { version: 1, users: {} };
  if (value.version !== 1 || !value.users || typeof value.users !== 'object' || Array.isArray(value.users) ||
      Object.values(value.users).some(items => !Array.isArray(items) || items.some(item =>
        !item || typeof item.id !== 'string' || !Array.isArray(item.photos) ||
        item.photos.some(photo => !photo || typeof photo.path !== 'string')))) {
    throw new Error('本机草稿索引异常，请勿清除数据，稍后重试');
  }
  return clone(value);
}
function root() { return `${wx.env.USER_DATA_PATH}/spot-drafts-v1`; }
function prefix(userId, id) { return `${root()}/${encodeURIComponent(userId)}_${id}_`; }
function checkId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{8,80}$/.test(id)) throw new Error('无效草稿编号');
}
function createId() { return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
function fsCall(method, args) {
  return new Promise((resolve, reject) => wx.getFileSystemManager()[method]({
    ...args, success: resolve, fail: error => reject(new Error(error.errMsg || '本机文件保存失败'))
  }));
}
async function stat(path) {
  const result = await fsCall('stat', { path });
  return Number(result.stats.size);
}
async function unlink(path) {
  // Only individual files owned by this module; no recursive directory deletion.
  if (!path.startsWith(`${root()}/`) || path.slice(root().length + 1).includes('/')) return;
  await fsCall('unlink', { filePath: path }).catch(() => {});
}
async function ensureDirectory() {
  try { await fsCall('access', { path: root() }); }
  catch (_) { await fsCall('mkdir', { dirPath: root(), recursive: true }); }
}
async function diskBytes() {
  const result = await fsCall('readdir', { dirPath: root() });
  let bytes = 0;
  for (const file of result.files) bytes += await stat(`${root()}/${file}`);
  return bytes;
}
async function collectOrphans(manifest) {
  // After an interrupted copy or failed deletion, retry only module-owned flat files.
  const referenced = new Set(Object.values(manifest.users).flatMap(items => items.flatMap(item => item.photos.map(photo => photo.path))));
  let result;
  try { result = await fsCall('readdir', { dirPath: root() }); }
  catch (_) { return 0; }
  let pending = 0;
  for (const file of result.files) {
    if (!/^[A-Za-z0-9%_.~-]+_draft-[a-z0-9-]+_[a-z0-9-]+\.(jpe?g|png|webp|gif|heic)$/i.test(file)) continue;
    const path = `${root()}/${file}`;
    if (referenced.has(path)) continue;
    await unlink(path);
    try { await stat(path); pending += 1; } catch (_) { /* removed */ }
  }
  return pending;
}
function formSnapshot(data) {
  const fields = ['title', 'description', 'accessNote', 'heading', 'focalLength', 'addressInput'];
  const snapshot = {};
  fields.forEach(field => { snapshot[field] = typeof data[field] === 'string' ? data[field] : ''; });
  snapshot.bestTimes = Array.isArray(data.bestTimes) ? data.bestTimes.slice() : [];
  snapshot.bestSeasons = Array.isArray(data.bestSeasons) ? data.bestSeasons.slice() : [];
  snapshot.difficulty = [1, 2, 3].includes(data.difficulty) ? data.difficulty : null;
  snapshot.latitude = data.latitude;
  snapshot.longitude = data.longitude;
  snapshot.step = data.step === 2 ? 2 : 1;
  snapshot.locationConfirmed = Boolean(data.locationConfirmed);
  snapshot.geoMeta = data.geoMeta ? {
    province: data.geoMeta.province || null, city: data.geoMeta.city || null,
    district: data.geoMeta.district || null, address: snapshot.addressInput || null
  } : null;
  return snapshot;
}

function list(userId) {
  return run(async () => {
    const key = ownerKey(userId);
    const manifest = readManifest();
    await collectOrphans(manifest);
    return (manifest.users[key] || []).sort((a, b) => b.updatedAt - a.updatedAt).map(item => clone(item));
  });
}
function load(userId, id) {
  return run(async () => {
    checkId(id);
    const draft = (readManifest().users[ownerKey(userId)] || []).find(item => item.id === id);
    if (!draft) throw new Error('草稿不存在或不属于当前账号');
    const photos = [];
    let missingPhotos = 0;
    for (const photo of draft.photos) {
      if (!photo.path.startsWith(prefix(userId, id))) { missingPhotos += 1; continue; }
      try {
        await stat(photo.path);
        photos.push({ tempPath: photo.path, url: photo.path });
      } catch (_) { missingPhotos += 1; }
    }
    return { ...clone(draft), photos, missingPhotos };
  });
}
function save(userId, id, data, options = {}) {
  // Snapshot immediately: input may change while an older save owns the queue.
  const snapshot = formSnapshot(data);
  const sourcePhotos = (data.photos || []).map(photo => ({ ...photo }));
  return run(async () => {
    const active = options.isCurrent || (() => true);
    if (!active()) return null;
    const key = ownerKey(userId);
    checkId(id);
    const manifest = readManifest();
    const drafts = manifest.users[key] || [];
    const previous = drafts.find(item => item.id === id);
    if (!previous && drafts.length >= MAX_DRAFTS) throw new Error('当前账号已有 10 份草稿，请先到草稿箱清理');
    if (sourcePhotos.length > 9) throw new Error('草稿最多保存 9 张照片');
    await ensureDirectory();
    await collectOrphans(manifest);
    let usedBytes = await diskBytes();
    const photos = [];
    const created = [];
    try {
      for (const photo of sourcePhotos) {
        const source = photo.tempPath;
        if (!source) throw new Error('草稿照片缺少本地文件，请重新选择图片');
        const size = await stat(source);
        if (!Number.isFinite(size) || size < 0) throw new Error('无法读取草稿图片大小');
        let path = source;
        const isOwned = source.startsWith(prefix(userId, id)) && previous &&
          previous.photos.some(item => item.path === source);
        if (!isOwned) {
          if (usedBytes + size > MAX_PHOTO_BYTES) throw new Error('本机草稿图片已达 100 MB 上限，请先到草稿箱清理');
          const suffix = (source.match(/\.(jpe?g|png|webp|gif|heic)$/i) || [null, 'jpg'])[1];
          path = `${prefix(userId, id)}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.${suffix}`;
          created.push(path);
          await fsCall('copyFile', { srcPath: source, destPath: path });
          if (await stat(path) !== size) throw new Error('照片未完整保存，请重试');
          usedBytes += size;
        }
        photos.push({ path, size });
      }
      if (!active()) {
        for (const path of created) await unlink(path);
        return null;
      }
      const draft = { id, updatedAt: Date.now(), ...snapshot, photos };
      manifest.users[key] = drafts.filter(item => item.id !== id).concat(draft);
      wx.setStorageSync(STORAGE_KEY, manifest);
      const retained = new Set(photos.map(photo => photo.path));
      for (const photo of (previous && previous.photos) || []) {
        if (!retained.has(photo.path) && photo.path.startsWith(prefix(userId, id))) await unlink(photo.path);
      }
      return clone(draft);
    } catch (error) {
      for (const path of created) await unlink(path);
      throw error;
    }
  });
}
function remove(userId, id) {
  return run(async () => {
    const key = ownerKey(userId);
    checkId(id);
    const manifest = readManifest();
    const drafts = manifest.users[key] || [];
    const target = drafts.find(item => item.id === id);
    if (!target) return;
    manifest.users[key] = drafts.filter(item => item.id !== id);
    wx.setStorageSync(STORAGE_KEY, manifest);
    for (const photo of target.photos) {
      if (photo.path.startsWith(prefix(userId, id))) await unlink(photo.path);
    }
    return { cleanupPending: await collectOrphans(manifest) };
  });
}

module.exports = { list, load, save, remove, createId, formSnapshot, MAX_DRAFTS, MAX_PHOTO_BYTES };

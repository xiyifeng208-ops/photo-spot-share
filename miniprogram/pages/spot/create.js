const config = require('../../config/index');
const { request } = require('../../utils/request');
const auth = require('../../utils/auth');
const geo = require('../../utils/geo');
const format = require('../../utils/format');
const { uploadPhotos } = require('../../utils/upload');

const REVERSE_DEBOUNCE_MS = 500;

Page({
  data: {
    step: 1,
    editId: '',
    isEdit: false,
    submitting: false,

    latitude: config.defaultCenter.latitude,
    longitude: config.defaultCenter.longitude,
    scale: 16,

    addressText: '正在获取地址…',
    addressInput: '',
    geoMeta: null,
    geoConfigured: true,
    locating: false,
    located: false,

    title: '',
    description: '',
    accessNote: '',
    heading: '',
    bestTimes: [],
    bestSeasons: [],
    focalLength: '',
    difficulty: 1,

    photos: [],
    maxPhotos: config.maxPhotos,
    agreed: false,

    headingOptions: format.HEADING_OPTIONS,
    bestTimeOptions: format.BEST_TIME_OPTIONS,
    seasonOptions: format.SEASON_OPTIONS,
    focalLengthOptions: format.FOCAL_LENGTH_OPTIONS,
    difficultyOptions: format.DIFFICULTY_OPTIONS
  },

  async onLoad(query) {
    this.mapContext = wx.createMapContext('pickerMap', this);
    this.reverseTimer = null;
    this.reverseSeq = 0;

    await auth.ensureLogin().catch(() => null);

    if (query.id) {
      this.setData({ editId: query.id, isEdit: true });
      wx.setNavigationBarTitle({ title: '编辑机位' });
      await this.loadForEdit(query.id);
      return;
    }

    // 选点是精确落点的场景，这里才用高精度定位
    this.setData({ locating: true });
    const location = await geo.getUserLocation({ highAccuracy: true, timeoutMs: 6000 });
    this.setData({ locating: false });

    if (location) {
      this.setData({
        latitude: location.latitude,
        longitude: location.longitude,
        scale: 17,
        located: true
      });
      // 直接用定位坐标反查地址，不要回读地图中心（见 reverseGeocodeAt 的说明）
      this.reverseGeocodeAt(location.latitude, location.longitude);
    } else {
      this.reverseGeocodeAt(this.data.latitude, this.data.longitude);
    }
    this.syncOptionSelection();
  },

  onUnload() {
    if (this.reverseTimer) clearTimeout(this.reverseTimer);
  },

  async loadForEdit(id) {
    const spot = await request({ url: `/spots/${id}` }).catch((error) => {
      wx.showToast({ title: error.message || '加载失败', icon: 'none' });
      return null;
    });
    if (!spot) return;

    this.setData({
      latitude: spot.lat,
      longitude: spot.lng,
      scale: 16,
      addressText: [spot.province, spot.city, spot.district, spot.address].filter(Boolean).join(' ') || '未获取到地址',
      addressInput: spot.address || '',
      geoMeta: {
        province: spot.province,
        city: spot.city,
        district: spot.district,
        address: spot.address
      },
      title: spot.title,
      description: spot.description || '',
      accessNote: spot.accessNote || '',
      heading: spot.heading || '',
      bestTimes: spot.bestTimes || [],
      bestSeasons: spot.bestSeasons || [],
      focalLength: spot.focalLength || '',
      difficulty: spot.difficulty || 1,
      photos: (spot.photos || []).map((photo) => ({ key: photo.key, url: photo.url })),
      step: 2
    });
    this.syncOptionSelection();
  },

  /**
   * WXML 的表达式不支持调用数组方法（`bestTimes.indexOf(...)` 在模板里恒为 undefined），
   * 所以多选项的选中态必须在 JS 里算好，模板只做 `item.selected` 这种简单判断。
   */
  syncOptionSelection() {
    const mark = (options, selected) =>
      options.map((option) => ({
        ...option,
        selected: (selected || []).indexOf(option.value) > -1
      }));

    this.setData({
      bestTimeOptions: mark(format.BEST_TIME_OPTIONS, this.data.bestTimes),
      seasonOptions: mark(format.SEASON_OPTIONS, this.data.bestSeasons)
    });
  },

  // ---------- 第一步：选点 ----------

  onRegionChange(event) {
    if (event.type !== 'end') return;
    this.scheduleReverse();
  },

  scheduleReverse() {
    if (this.reverseTimer) clearTimeout(this.reverseTimer);
    this.reverseTimer = setTimeout(() => this.reverseGeocode(), REVERSE_DEBOUNCE_MS);
  },

  /** 拖动地图时用地图中心反查地址。 */
  async reverseGeocode() {
    const center = await geo.getCenterLocation(this.mapContext).catch(() => null);
    if (!center) return;
    this.reverseGeocodeAt(center.latitude, center.longitude);
  },

  /**
   * 用指定坐标反查地址。
   * 进入页面时直接传定位坐标——此刻地图中心可能还没同步到定位点，回读会拿到旧位置；
   * 拖动地图时由 reverseGeocode() 传地图中心进来。
   */
  async reverseGeocodeAt(latitude, longitude) {
    const seq = (this.reverseSeq += 1);

    this.setData({
      latitude,
      longitude,
      addressText: '正在获取地址…'
    });

    let meta = null;
    let failure = null;
    try {
      meta = await request({
        url: `/geo/reverse?lng=${longitude}&lat=${latitude}`
      });
    } catch (error) {
      failure = error;
    }

    // 快速拖动时丢弃过期结果
    if (seq !== this.reverseSeq) return;

    // 必须区分"服务端没配 Key"和"配了但调用失败"：
    // 早前把两者混成一句话，Key 类型选错时会让人往错的方向排查。
    if (failure) {
      this.setData({
        geoMeta: null,
        geoConfigured: true,
        addressText: `${failure.message || '地址服务调用失败'}；可在下方手动填写地址`
      });
      return;
    }

    if (!meta || !meta.configured) {
      this.setData({
        geoMeta: null,
        geoConfigured: false,
        addressText: '未接入逆地理编码（服务端没配高德 Key），请在下方手动填写地址'
      });
      return;
    }

    this.setData({
      geoConfigured: true,
      geoMeta: {
        province: meta.province,
        city: meta.city,
        district: meta.district,
        address: meta.address
      },
      addressInput:
        meta.address ||
        [meta.province, meta.city, meta.district].filter(Boolean).join(' ') ||
        '',
      addressText:
        meta.address ||
        [meta.province, meta.city, meta.district].filter(Boolean).join(' ') ||
        '附近没有可用的地名，请在下方手动填写'
    });
  },

  async onUseCurrentLocation() {
    const location = await geo.getUserLocation();
    if (!location) {
      const opened = await geo.openLocationSetting();
      if (!opened) {
        wx.showToast({ title: '未获得定位权限', icon: 'none' });
      }
      return;
    }
    this.setData({
      latitude: location.latitude,
      longitude: location.longitude,
      scale: 17
    });
    this.scheduleReverse();
  },

  onNextStep() {
    this.setData({ step: 2 });
  },

  onBackToStep1() {
    this.setData({ step: 1 });
  },

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  onOpenLegal(event) {
    wx.navigateTo({ url: `/pages/legal/index?type=${event.currentTarget.dataset.type}` });
  },

  // ---------- 第二步：表单 ----------

  onInput(event) {
    const field = event.currentTarget.dataset.field;
    this.setData({ [field]: event.detail.value });
  },

  onPickSingle(event) {
    const { field, value } = event.currentTarget.dataset;
    const next = this.data[field] === value ? '' : value;
    this.setData({ [field]: next });
  },

  onToggleMulti(event) {
    const { field, value } = event.currentTarget.dataset;
    const list = this.data[field] || [];
    const next = list.includes(value) ? list.filter((item) => item !== value) : list.concat(value);
    this.setData({ [field]: next });
    // 选中态跟着刷新，否则模板里的高亮不会变（看起来像"点不动"）
    this.syncOptionSelection();
  },

  onPickDifficulty(event) {
    this.setData({ difficulty: Number(event.currentTarget.dataset.value) });
  },

  onChoosePhoto() {
    const remaining = this.data.maxPhotos - this.data.photos.length;
    if (remaining <= 0) {
      wx.showToast({ title: `最多 ${this.data.maxPhotos} 张`, icon: 'none' });
      return;
    }

    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const added = res.tempFiles.map((file) => ({
          tempPath: file.tempFilePath,
          url: file.tempFilePath
        }));
        this.setData({ photos: this.data.photos.concat(added) });
      }
    });
  },

  onRemovePhoto(event) {
    const index = Number(event.currentTarget.dataset.index);
    const photos = this.data.photos.slice();
    photos.splice(index, 1);
    this.setData({ photos });
  },

  onPreviewPhoto(event) {
    const index = Number(event.currentTarget.dataset.index);
    wx.previewImage({
      current: this.data.photos[index].url,
      urls: this.data.photos.map((photo) => photo.url)
    });
  },

  async onSubmit() {
    if (this.data.submitting) return;

    const title = (this.data.title || '').trim();
    if (title.length < 2) {
      wx.showToast({ title: '标题至少 2 个字', icon: 'none' });
      return;
    }
    if (!this.data.photos.length) {
      wx.showToast({ title: '至少上传 1 张样张', icon: 'none' });
      return;
    }
    if (!this.data.isEdit && !this.data.agreed) {
      wx.showToast({ title: '请先阅读并同意用户协议', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '发布中…', mask: true });

    try {
      const tempPaths = this.data.photos.filter((photo) => photo.tempPath).map((photo) => photo.tempPath);
      let uploadedKeys = [];
      if (tempPaths.length) {
        const uploaded = await uploadPhotos(tempPaths);
        uploadedKeys = uploaded.keys;
      }

      let uploadedIndex = 0;
      const photoKeys = this.data.photos.map((photo) => {
        if (photo.key) return photo.key;
        const key = uploadedKeys[uploadedIndex];
        uploadedIndex += 1;
        return key;
      });

      const payload = {
        title,
        description: this.data.description || '',
        lat: this.data.latitude,
        lng: this.data.longitude,
        photoKeys,
        difficulty: this.data.difficulty
      };
      // 手动填写的地址优先于逆地理结果；没配高德 Key 时它是唯一的地址来源
      const manualAddress = (this.data.addressInput || '').trim();
      const geo = { ...(this.data.geoMeta || {}) };
      if (manualAddress) geo.address = manualAddress.slice(0, 120);
      if (geo.province || geo.city || geo.district || geo.address) payload.geo = geo;

      if (this.data.heading) payload.heading = this.data.heading;
      if (this.data.bestTimes.length) payload.bestTimes = this.data.bestTimes;
      if (this.data.bestSeasons.length) payload.bestSeasons = this.data.bestSeasons;
      if (this.data.focalLength) payload.focalLength = this.data.focalLength;
      if (this.data.accessNote) payload.accessNote = this.data.accessNote;

      const saved = await request({
        url: this.data.isEdit ? `/spots/${this.data.editId}` : '/spots',
        method: this.data.isEdit ? 'PATCH' : 'POST',
        data: payload
      });

      wx.hideLoading();
      const pending = saved && saved.status === 'pending';
      wx.showToast({
        title: this.data.isEdit ? '已更新' : pending ? '已提交，审核通过后公开' : '发布成功',
        icon: pending ? 'none' : 'success'
      });
      setTimeout(() => {
        if (this.data.isEdit) {
          wx.navigateBack();
        } else {
          wx.redirectTo({ url: `/pages/spot/detail?id=${saved.id}` });
        }
      }, 700);
    } catch (error) {
      wx.hideLoading();
      wx.showToast({ title: error.message || '发布失败', icon: 'none' });
    } finally {
      this.setData({ submitting: false });
    }
  }
});

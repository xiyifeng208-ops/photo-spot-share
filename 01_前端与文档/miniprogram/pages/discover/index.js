const { request } = require('../../utils/request');
const auth = require('../../utils/auth');
const geo = require('../../utils/geo');
const format = require('../../utils/format');
const { provinces } = require('../../data/cities');
const PAGE_SIZE = 10;
const SEARCH_DELAY_MS = 300;
const CONDITION_GROUPS = [
  { field: 'bestTimes', label: '拍摄时段', options: format.BEST_TIME_OPTIONS },
  { field: 'bestSeasons', label: '推荐季节', options: format.SEASON_OPTIONS },
  { field: 'focalLengths', label: '推荐焦段', options: format.FOCAL_LENGTH_OPTIONS },
  { field: 'difficulties', label: '到达难度', options: format.DIFFICULTY_OPTIONS }
];

function emptyConditions() {
  return { bestTimes: [], bestSeasons: [], focalLengths: [], difficulties: [] };
}

function copyConditions(filters) {
  return Object.fromEntries(CONDITION_GROUPS.map(group => [group.field, filters[group.field].slice()]));
}

function conditionGroups(filters) {
  return CONDITION_GROUPS.map(group => ({
    field: group.field, label: group.label,
    options: group.options.map(option => ({ ...option, value: String(option.value),
      selected: filters[group.field].includes(String(option.value)) }))
  }));
}

function conditionSummary(filters) {
  return CONDITION_GROUPS.flatMap(group => group.options
    .filter(option => filters[group.field].includes(String(option.value)))
    .map(option => ({ key: `${group.field}:${option.value}`, field: group.field,
      value: String(option.value), label: option.label })));
}

function decorate(spot) {
  return { ...spot, favoriteCount: Number.isSafeInteger(spot.favoriteCount) && spot.favoriteCount >= 0 ? spot.favoriteCount : 0,
    distanceText: format.formatDistance(spot.distanceMeters),
    createdText: format.formatDate(spot.createdAt), tagList: format.buildTags(spot) };
}

Page({
  data: {
    province: '', city: '', district: '', cityLabel: '全部城市',
    keywordInput: '', keyword: '', sortHint: '', cityPickerOpen: false,
    provinces: provinces.map(({ code, name }) => ({ code, name })),
    pickerProvinceCode: provinces[0].code, pickerCities: provinces[0].cities,
    selectedCityCode: '',
    shootingPickerOpen: false,
    shootingFilters: emptyConditions(), draftFilters: emptyConditions(),
    filterGroups: conditionGroups(emptyConditions()), selectedConditions: [],
    spots: [], cursor: '', loading: false, finished: false, error: '', located: false
  },

  onLoad() {
    this.queryRevision = 0;
    this.unloaded = false;
    this.userPickedFilter = false;
    this.visible = false;
    this.hasShown = false;
    this.favoriteCountRevision = this.currentFavoriteRevision();
    this.reload();
    this.bootstrapCity();
  },

  currentFavoriteRevision() {
    const app = getApp();
    return (app && app.globalData && app.globalData.favoriteCountRevision) || 0;
  },
  onShow() {
    this.visible = true;
    const needsRefresh = this.hasShown || this.favoriteCountRevision !== this.currentFavoriteRevision();
    this.hasShown = true;
    this.favoriteCountRevision = this.currentFavoriteRevision();
    // Counts may also have changed on another device. Return to the first page,
    // retaining the entire current city/keyword/condition selection.
    if (needsRefresh && !this.unloaded) {
      this.setData({ keyword: this.data.keywordInput.trim() });
      return this.reload();
    }
  },
  onHide() { this.visible = false; },
  onFavoriteCountsChanged() {
    if (!this.visible || this.unloaded || this.favoriteCountRevision === this.currentFavoriteRevision()) return;
    this.favoriteCountRevision = this.currentFavoriteRevision();
    this.setData({ keyword: this.data.keywordInput.trim() });
    return this.reload();
  },

  onUnload() {
    this.unloaded = true;
    this.visible = false;
    this.queryRevision += 1;
    clearTimeout(this.searchTimer);
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.error) this.loadMore();
  },

  async bootstrapCity() {
    await auth.ensureLogin().catch(() => null);
    if (this.unloaded || this.userPickedFilter) return;
    const location = await geo.getUserLocation({ highAccuracy: false, timeoutMs: 3000 });
    if (!location || this.unloaded || this.userPickedFilter) return;
    const meta = await request({
      url: `/geo/reverse?lng=${location.longitude}&lat=${location.latitude}`
    }).catch(() => null);
    if (!meta || this.unloaded || this.userPickedFilter) return;
    const province = provinces.find(p => p.name === meta.province);
    const city = province && province.cities.find(c =>
      c.name === (c.field === 'district' ? meta.district : meta.city));
    if (city) {
      this.setRegion(province, city);
      this.setData({ located: true });
      this.reload();
    } else if (meta.city) {
      this.setData({ province: meta.province || '', city: meta.city, cityLabel: meta.city, located: true });
      this.reload();
    }
  },

  // Invalidate on input, before debounce: older results must never win.
  resetQuery() {
    this.queryRevision = (this.queryRevision || 0) + 1;
    this.setData({ spots: [], cursor: '', finished: false, loading: true, error: '' });
    return this.queryRevision;
  },

  reload() {
    clearTimeout(this.searchTimer);
    this.favoriteCountRevision = this.currentFavoriteRevision();
    return this.fetchPage(this.resetQuery(), '');
  },

  loadMore() {
    if (this.data.loading || this.data.finished || this.unloaded) return Promise.resolve();
    return this.fetchPage(this.queryRevision, this.data.cursor);
  },

  async fetchPage(revision, cursor) {
    if (this.unloaded || revision !== this.queryRevision) return;
    this.setData({ loading: true, error: '', sortHint: this.data.keyword.trim() ? '按收藏数排序' : '' });
    const app = getApp();
    const viewer = (app && app.globalData.lastLocation) || null;
    const query = [`limit=${PAGE_SIZE}`];
    for (const field of ['province', 'city', 'district', 'keyword']) {
      if (this.data[field]) query.push(`${field}=${encodeURIComponent(this.data[field])}`);
    }
    for (const group of CONDITION_GROUPS) {
      const values = this.data.shootingFilters[group.field];
      if (values.length) query.push(`${group.field}=${encodeURIComponent(values.join(','))}`);
    }
    if (cursor) query.push(`cursor=${encodeURIComponent(cursor)}`);
    if (viewer) query.push(`viewerLat=${viewer.latitude}`, `viewerLng=${viewer.longitude}`);
    try {
      const result = await request({ url: `/spots/feed?${query.join('&')}` });
      if (this.unloaded || revision !== this.queryRevision) return;
      // Counts can change between cursor pages. Deduplicate repeated IDs but
      // never sort a partial page: keep the server's first-seen order/cursor.
      const combined = (cursor ? this.data.spots : []).concat(result.items.map(decorate));
      const byId = new Map(combined.map(item => [item.id, item]));
      this.setData({
        spots: [...byId.values()],
        cursor: result.nextCursor || '', finished: !result.nextCursor, loading: false, error: ''
      });
    } catch (error) {
      if (this.unloaded || revision !== this.queryRevision) return;
      this.setData({ loading: false, error: error.message || '作品加载失败，请重试' });
    }
  },

  onRetry() {
    return this.data.spots.length ? this.loadMore() : this.reload();
  },

  onToggleCity() {
    this.userPickedFilter = true;
    this.onCloseShootingPicker();
    this.setData({ cityPickerOpen: !this.data.cityPickerOpen });
  },

  onCloseCityPicker() { this.setData({ cityPickerOpen: false }); },
  onPanelTouchMove() {},

  onOpenShootingPicker() {
    this.userPickedFilter = true;
    if (wx.hideKeyboard) wx.hideKeyboard();
    const draftFilters = copyConditions(this.data.shootingFilters);
    this.setData({ shootingPickerOpen: true, cityPickerOpen: false, draftFilters,
      filterGroups: conditionGroups(draftFilters) });
  },

  onCloseShootingPicker() {
    const draftFilters = copyConditions(this.data.shootingFilters);
    this.setData({ shootingPickerOpen: false, draftFilters, filterGroups: conditionGroups(draftFilters) });
  },

  onDraftConditionTap(event) {
    const { field, value } = event.currentTarget.dataset;
    const group = CONDITION_GROUPS.find(item => item.field === field);
    if (!group || !group.options.some(option => String(option.value) === String(value))) return;
    const draftFilters = copyConditions(this.data.draftFilters);
    const values = draftFilters[field];
    const selected = values.includes(String(value))
      ? values.filter(item => item !== String(value)) : values.concat(String(value));
    // Keep option order stable regardless of tap order.
    draftFilters[field] = group.options.map(option => String(option.value)).filter(item => selected.includes(item));
    this.setData({ draftFilters, filterGroups: conditionGroups(draftFilters) });
  },

  onResetDraftConditions() {
    const draftFilters = emptyConditions();
    this.setData({ draftFilters, filterGroups: conditionGroups(draftFilters) });
  },

  applyShootingFilters(filters) {
    this.userPickedFilter = true;
    const shootingFilters = copyConditions(filters);
    this.setData({ shootingFilters, selectedConditions: conditionSummary(shootingFilters),
      shootingPickerOpen: false, cityPickerOpen: false });
    return this.reload();
  },

  onConfirmConditions() { return this.applyShootingFilters(this.data.draftFilters); },

  onRemoveCondition(event) {
    const { field, value } = event.currentTarget.dataset;
    if (!CONDITION_GROUPS.some(group => group.field === field)) return;
    const filters = copyConditions(this.data.shootingFilters);
    filters[field] = filters[field].filter(item => item !== String(value));
    return this.applyShootingFilters(filters);
  },

  onClearConditions() { return this.applyShootingFilters(emptyConditions()); },

  onSelectProvince(event) {
    const province = provinces.find(p => p.code === event.currentTarget.dataset.code);
    if (!province) return;
    this.userPickedFilter = true;
    this.setData({ pickerProvinceCode: province.code, pickerCities: province.cities });
  },

  setRegion(province, city) {
    this.setData({
      province: province.name,
      city: city.field === 'city' ? city.name : '',
      district: city.field === 'district' ? city.name : '',
      cityLabel: city.name, pickerProvinceCode: province.code, pickerCities: province.cities,
      selectedCityCode: city.code, cityPickerOpen: false
    });
  },

  onSelectCity(event) {
    const province = provinces.find(p => p.code === this.data.pickerProvinceCode);
    const city = province && province.cities.find(c => c.code === event.currentTarget.dataset.code);
    if (!city) return;
    this.userPickedFilter = true;
    this.setRegion(province, city);
    return this.reload();
  },

  onSelectAllCities() {
    this.userPickedFilter = true;
    this.setData({ province: '', city: '', district: '', cityLabel: '全部城市', selectedCityCode: '', cityPickerOpen: false });
    return this.reload();
  },

  onSearchFocus() {
    this.userPickedFilter = true;
    this.onCloseCityPicker();
    this.onCloseShootingPicker();
  },

  onSearchInput(event) {
    this.userPickedFilter = true;
    const value = event.detail.value.slice(0, 100);
    const keyword = value.trim();
    this.setData({ keywordInput: value, cityPickerOpen: false });
    if (keyword === this.data.keyword) return;
    clearTimeout(this.searchTimer);
    this.setData({ keyword });
    const revision = this.resetQuery();
    if (!keyword) return this.fetchPage(revision, '');
    this.searchTimer = setTimeout(() => this.fetchPage(revision, ''), SEARCH_DELAY_MS);
  },

  onSearchConfirm() {
    this.userPickedFilter = true;
    this.setData({ keyword: this.data.keywordInput.trim(), cityPickerOpen: false });
    return this.reload();
  },

  onClearSearch() {
    this.userPickedFilter = true;
    this.setData({ keywordInput: '', keyword: '' });
    return this.reload();
  },

  onSpotTap(event) {
    wx.navigateTo({ url: `/pages/spot/detail?id=${event.currentTarget.dataset.id}` });
  },

  onCoverError(event) {
    const id = event.currentTarget.dataset.id;
    this.setData({ spots: this.data.spots.map(spot => spot.id === id ? { ...spot, coverFailed: true, coverUrl: '' } : spot) });
  },

  onRoutesTap() {
    this.setData({ cityPickerOpen: false, shootingPickerOpen: false });
    wx.navigateTo({ url: '/pages/routes/index' });
  },
  onCreateTap() { wx.navigateTo({ url: '/pages/spot/create' }); }
});

const config = require('../../config/index');
const { request } = require('../../utils/request');
const auth = require('../../utils/auth');
const geo = require('../../utils/geo');
const format = require('../../utils/format');

const MARKER_ICON = '/images/marker.png';
const MARKER_ICON_ACTIVE = '/images/marker-active.png';
const CLUSTER_ICON = '/images/marker-cluster.png';

/**
 * 地图宽限期：启动阶段同时挂着登录、定位、首屏请求，地图的 updated 事件
 * 可能比想象中晚；在这个窗口内只提示"正在加载"，不判定失败。
 */
const MAP_READY_GRACE_MS = 8000;

/**
 * getRegion 在原生化地图重绘期间会丢回调（组件还在、updated 也在触发，就是这一帧不回答）。
 * 所以它只算"暂时拿不到"，多试几次再判定失败。
 */
const REGION_RETRY_LIMIT = 2;
const REGION_RETRY_DELAYS = [600, 1500];

/** WXML 里不能调用页面方法，距离文案在 JS 里预先算好。 */
function decorate(spot) {
  return {
    ...spot,
    distanceText: format.formatDistance(spot.distanceMeters),
    tagList: format.buildTags(spot)
  };
}

Page({
  data: {
    latitude: config.defaultCenter.latitude,
    longitude: config.defaultCenter.longitude,
    scale: config.defaultCenter.scale,
    markers: [],
    mode: 'points',
    selected: null,
    loading: false,
    truncated: false,
    located: false,
    locationDenied: false,
    mapFailed: false,
    failReason: '',
    fallbackDesc: '',
    fallbackSummary: '',
    debug: config.debug,
    debugLine: '',
    tip: ''
  },

  onLoad() {
    this.mapContext = wx.createMapContext('spotMap', this);
    this.markerIndex = {};
    this.requestSeq = 0;
    this.refreshTimer = null;
    this.retryCount = 0;
    this.mapReady = false;
    this.mapUpdatedCount = 0;
    this.mapError = '';
    this.loadedAt = Date.now();
    this.mapReadyGraceMs = MAP_READY_GRACE_MS;
    this.regionTimeoutMs = 5000;
    this.firstShow = true;
    this.bootstrap();
  },

  onShow() {
    // onLoad 之后紧跟的第一次 onShow 不算"返回"
    const isReturning = !this.firstShow;
    this.firstShow = false;
    if (!isReturning) return;

    // 返回时只重建 MapContext（旧的已经失效）并重新计时宽限期。
    // 这里刻意不做"卸载再挂载"：自动重建原生地图一旦失败，地图就再也回不来了，
    // 代价比收益大。真出现画面空白时，由用户点「重新加载地图」触发重建。
    this.resetMapContext();
    this.scheduleRefresh(300);
  },

  resetMapContext() {
    this.mapContext = wx.createMapContext('spotMap', this);
    this.mapReady = false;
    this.mapUpdatedCount = 0;
    this.loadedAt = Date.now();
    this.retryCount = 0;
    if (this.data.mapFailed) {
      this.setData({ mapFailed: false, failReason: '', fallbackDesc: '', fallbackSummary: '', tip: '' });
    }
  },

  onUnload() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  },

  /**
   * 首屏不再串行等待登录和定位：
   * 先用默认视野把地图和点位渲染出来，登录/定位在后台并行完成后再校正视野。
   * 之前只要定位不回调，整页就永远停在"加载中"。
   */
  async bootstrap() {
    this.scheduleRefresh(1000);

    const [, location] = await Promise.all([
      auth.ensureLogin().catch(() => null),
      geo.getUserLocation({ highAccuracy: false, timeoutMs: 3000 })
    ]);

    if (location) {
      this.viewScale = 14;
      const patch = {
        latitude: location.latitude,
        longitude: location.longitude,
        scale: 14,
        located: true,
        locationDenied: false
      };
      // 别把已经存在的失败提示覆盖掉，否则顶栏显示的就不是真实原因了
      if (!this.data.mapFailed) patch.tip = '';
      this.setData(patch);
      this.scheduleRefresh(200);
      return;
    }

    const fallback = geo.defaultRegion();
    this.viewScale = fallback.scale;
    const fallbackPatch = {
      ...fallback,
      located: false,
      locationDenied: true
    };
    if (!this.data.mapFailed) fallbackPatch.tip = '未获得定位权限，已显示全国视图';
    this.setData(fallbackPatch);
    // 定位失败不需要再补一次请求：初始那次已经用过默认视野了
  },

  /** 地图首帧渲染完成后立刻拉一次点位（之前的第一次请求经常跑在地图就绪之前）。 */
  onMapReady() {
    this.mapUpdatedCount += 1;
    if (this.mapReady) return;
    this.mapReady = true;
    // 地图姗姗来迟也没关系：重置重试计数并清掉失败态，让它自己恢复
    this.retryCount = 0;
    if (this.data.mapFailed) {
      this.setData({ mapFailed: false, failReason: '', fallbackDesc: '', fallbackSummary: '', tip: '' });
    }
    this.scheduleRefresh(0);
  },

  /** 地图组件自身报错时记下来，方便定位是组件问题还是数据问题。 */
  onMapError(event) {
    this.mapError = JSON.stringify((event && event.detail) || {});
    this.updateDebugLine('error');
  },

  updateDebugLine(regionState) {
    if (!this.data.debug) return;
    const waited = Math.round((Date.now() - this.loadedAt) / 1000);
    this.setData({
      debugLine: `updated×${this.mapUpdatedCount} ready=${this.mapReady ? 'Y' : 'N'} getRegion=${regionState} 等待${waited}s${this.mapError ? ` err=${this.mapError}` : ''}`
    });
  },

  onRegionChange(event) {
    if (event.type !== 'end') return;

    // 关键：用户手势产生的缩放级别只记在实例上、只用于查询，
    // 绝不写回 map 的 scale 属性——捏合过程中反复更新原生组件属性会把地图搞白。
    const detailScale =
      event.detail && typeof event.detail.scale === 'number' ? event.detail.scale : null;
    if (detailScale) this.viewScale = detailScale;

    this.scheduleRefresh();
  },

  onMarkerTap(event) {
    const spotId = this.markerIndex[event.detail.markerId];
    if (!spotId) return;

    if (spotId.type === 'cluster') {
      const nextScale = Math.max(
        config.clusterZoomThreshold + 2,
        (this.viewScale || this.data.scale) + 3
      );
      this.viewScale = nextScale;
      this.setData({
        latitude: spotId.lat,
        longitude: spotId.lng,
        scale: nextScale
      });
      this.scheduleRefresh(0);
      return;
    }

    this.setData({ selected: decorate(spotId.spot) });
    this.highlightMarker(spotId.spot.id);
  },

  onMapTap() {
    if (this.data.selected) this.setData({ selected: null });
  },

  scheduleRefresh(delay = 350) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshSpots();
    }, delay);
  },

  async refreshSpots() {
    const seq = (this.requestSeq += 1);
    this.setData({ loading: true });
    let stage = 'region';

    try {
      const region = await geo.getRegionBbox(this.mapContext, this.regionTimeoutMs);
      this.updateDebugLine('ok');
      stage = 'request';
      const app = getApp();
      const viewer = (app && app.globalData.lastLocation) || null;

      // 用用户实际看到的缩放级别查数据，而不是绑定在 map 上的那个值
      const zoom = this.viewScale || this.data.scale;
      const query = [`bbox=${region.bbox}`, `zoom=${zoom}`, 'limit=400'];
      if (viewer) {
        query.push(`viewerLat=${viewer.latitude}`, `viewerLng=${viewer.longitude}`);
      }

      const result = await request({ url: `/spots?${query.join('&')}` });

      // 快速拖动地图会让请求乱序返回，丢弃过期响应
      if (seq !== this.requestSeq) return;

      this.retryCount = 0;
      if (this.data.mapFailed) {
        this.setData({ mapFailed: false, failReason: '', fallbackDesc: '', fallbackSummary: '' });
      }

      if (result.mode === 'cluster') {
        this.applyClusters(result.clusters);
      } else {
        this.applySpots(result.items, result.truncated);
      }
    } catch (error) {
      if (seq !== this.requestSeq) return;
      this.updateDebugLine(stage === 'region' ? 'fail' : 'ok');
      this.handleRefreshFailure(error, stage);
    } finally {
      // getRegionBbox / request 都有超时兜底，这里一定会执行，loading 不会再卡住
      if (seq === this.requestSeq) this.setData({ loading: false });
    }
  },

  /**
   * 失败处理。关键是区分三种失败，别用同一句话糊弄用户：
   *   map    —— 地图组件根本没初始化（底图没画出来）
   *   region —— 地图在渲染，但这一帧拿不到视野（原生组件重绘时常见，可重试）
   *   data   —— 视野拿到了，是接口请求失败
   */
  handleRefreshFailure(error, stage = 'region') {
    const message = (error && error.message) || '加载失败';

    // 地图还没就绪：给足宽限期，期间只提示"正在加载"，不判定失败
    const waitedMs = Date.now() - this.loadedAt;
    if (!this.mapReady && waitedMs < this.mapReadyGraceMs) {
      this.setData({ tip: `地图正在加载…已等待 ${Math.round(waitedMs / 1000)} 秒` });
      this.scheduleRefresh(800);
      return;
    }

    // 地图活着的时候才值得重试：视野拿不到多试几次，接口抖动试一次。
    // 地图压根没起来就不要反复撞超时了，恢复路径是 ready 事件（onMapReady）。
    if (this.mapReady) {
      const limit = stage === 'region' ? REGION_RETRY_LIMIT : 1;
      if (this.retryCount < limit) {
        const delay =
          stage === 'region' ? REGION_RETRY_DELAYS[this.retryCount] ?? 1500 : 600;
        this.retryCount += 1;
        this.setData({
          tip:
            stage === 'region'
              ? `地图正在重绘，重试中（${this.retryCount}/${limit}）…`
              : '加载失败，正在重试…'
        });
        this.scheduleRefresh(delay);
        return;
      }
    }

    const failReason = stage === 'region' ? (this.mapReady ? 'region' : 'map') : 'data';
    const descriptions = {
      map: '开发者工具没能初始化地图组件（接口和数据都是正常的）。用列表页照样能浏览、创建和导航；换成真机预览地图会正常显示。',
      region:
        '地图在渲染，但连续几次都没能拿到它的可视范围（原生组件重绘期间会这样）。可以点「重新进入页面」整页重建试试。',
      data: `接口请求失败：${message}。请确认后端服务已启动（默认 http://localhost:3000）。`
    };
    const tips = {
      map: '地图没能渲染出来',
      region: '拿不到地图视野',
      data: `加载失败：${message}`
    };

    this.setData({
      mapFailed: true,
      failReason,
      fallbackDesc: descriptions[failReason],
      tip: tips[failReason]
    });
    this.loadFallbackSummary();
  },

  /** 地图渲染不出来时，至少把"数据是好的"这件事展示给用户。 */
  async loadFallbackSummary() {
    const result = await request({
      url: '/spots?bbox=73.5,3.5,135,53.6&zoom=6&limit=200'
    }).catch(() => null);

    if (!result || !result.clusters || !result.clusters.length) {
      this.setData({ fallbackSummary: '暂时拿不到机位汇总，可以先去发现页看看。' });
      return;
    }

    const total = result.clusters.reduce((sum, item) => sum + item.count, 0);
    const detail = result.clusters
      .slice(0, 6)
      .map((item) => `${item.city} ${item.count}`)
      .join('、');
    this.setData({ fallbackSummary: `全国目前有 ${total} 个机位：${detail}` });
  },

  onRetryTap() {
    this.retryCount = 0;
    this.setData({ mapFailed: false, failReason: '', fallbackDesc: '', fallbackSummary: '', tip: '' });
    // 整页重建而不是重建组件：wx:if 卸载再挂载原生地图，一旦重建失败地图就再也回不来
    wx.reLaunch({ url: '/pages/map/index' });
  },

  onGoDiscover() {
    wx.switchTab({ url: '/pages/discover/index' });
  },

  applyClusters(clusters) {
    this.markerIndex = {};
    const markers = clusters.map((cluster, index) => {
      this.markerIndex[index] = {
        type: 'cluster',
        lat: cluster.lat,
        lng: cluster.lng,
        cluster
      };

      return {
        id: index,
        latitude: cluster.lat,
        longitude: cluster.lng,
        iconPath: CLUSTER_ICON,
        width: 64,
        height: 64,
        label: {
          content: `${cluster.city} ${cluster.count}`,
          color: '#ffffff',
          fontSize: 11,
          anchorX: -30,
          anchorY: -6,
          bgColor: '#0d8578',
          padding: 4,
          borderRadius: 8
        }
      };
    });

    this.setData({
      markers,
      mode: 'cluster',
      truncated: false,
      selected: null,
      tip: clusters.length ? '' : '这一带还没有人分享机位，点右下角创建一个'
    });
  },

  applySpots(spots, truncated) {
    this.markerIndex = {};
    const decorated = spots.map(decorate);
    const markers = decorated.map((spot, index) => {
      this.markerIndex[index] = { type: 'spot', spot };
      return {
        id: index,
        latitude: spot.lat,
        longitude: spot.lng,
        iconPath: MARKER_ICON,
        width: 32,
        height: 43,
        callout: {
          content: spot.title,
          color: '#1f2430',
          fontSize: 12,
          bgColor: '#ffffff',
          padding: 6,
          borderRadius: 8,
          display: 'BYCLICK'
        }
      };
    });

    const selectedId = this.data.selected && this.data.selected.id;
    this.setData({
      markers,
      mode: 'points',
      truncated,
      selected: selectedId ? decorated.find((spot) => spot.id === selectedId) || null : null,
      tip: spots.length ? '' : '这一带还没有人分享机位，点右下角创建一个'
    });
  },

  highlightMarker(spotId) {
    const markers = this.data.markers.map((marker) => {
      const entry = this.markerIndex[marker.id];
      const isActive = entry && entry.type === 'spot' && entry.spot.id === spotId;
      return {
        ...marker,
        iconPath: isActive ? MARKER_ICON_ACTIVE : MARKER_ICON
      };
    });
    this.setData({ markers });
  },

  async onLocateTap() {
    // 用户主动点"回到我的位置"，值得多等一会儿换更准的坐标
    const location = await geo.getUserLocation({ highAccuracy: true, timeoutMs: 6000 });
    if (!location) {
      this.setData({ locationDenied: true });
      const opened = await geo.openLocationSetting();
      if (opened) return this.bootstrap();
      return;
    }

    this.viewScale = 14;
    this.setData({
      latitude: location.latitude,
      longitude: location.longitude,
      scale: 14,
      located: true,
      locationDenied: false,
      tip: ''
    });
    this.scheduleRefresh(0);
  },

  onCreateTap() {
    wx.navigateTo({ url: '/pages/spot/create' });
  },

  onCardTap() {
    const { selected } = this.data;
    if (!selected) return;
    wx.navigateTo({ url: `/pages/spot/detail?id=${selected.id}` });
  },

  onCardNavigate(event) {
    const spot = this.data.selected;
    if (!spot) return;
    event.stopPropagation && event.stopPropagation();
    wx.openLocation({
      latitude: spot.lat,
      longitude: spot.lng,
      name: spot.title,
      address: [spot.city, spot.district].filter(Boolean).join(' '),
      scale: 18
    });
  },

  onCardClose() {
    this.setData({ selected: null });
    this.highlightMarker('');
  }
});

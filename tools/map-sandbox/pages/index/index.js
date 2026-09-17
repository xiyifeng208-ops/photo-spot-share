// 四种最常见的 map 写法，各自记录自己的事件。
// 判断标准：只要某一格出现"updated 已触发"，说明地图组件本身能初始化，
// 那么业务里渲染不出来就是页面结构/配置的问题；如果一个都没触发，就是环境问题。
Page({
  data: {
    status1: '等待事件…',
    status2: '等待事件…',
    status3: '等待事件…',
    regionLog: '(还没调用 getRegion)',
    markers: [
      {
        id: 1,
        latitude: 31.2397,
        longitude: 121.4903,
        title: '外滩'
      }
    ]
  },

  onUpdated(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [key]: `updated 已触发 ${new Date().toLocaleTimeString()}` });
  },

  onError(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ [key]: `error: ${JSON.stringify(e.detail)}` });
  },

  onRegionChange(e) {
    this.setData({
      regionLog: `${e.type} causedBy=${e.causedBy ?? '-'}`
    });
  },

  // 业务代码里就是靠这个接口拿视野的，这里单独验证它有没有回调
  onGetRegion() {
    const ctx = wx.createMapContext('map1', this);
    this.setData({ regionLog: '已发起 getRegion，等回调…' });

    const timer = setTimeout(() => {
      this.setData({ regionLog: '⛔ getRegion 3 秒没有回调（这就是业务页面卡死的原因）' });
    }, 3000);

    ctx.getRegion({
      success: (res) => {
        clearTimeout(timer);
        this.setData({
          regionLog: `✅ getRegion 成功：${JSON.stringify(res.southwest)} ~ ${JSON.stringify(res.northeast)}`
        });
      },
      fail: (err) => {
        clearTimeout(timer);
        this.setData({ regionLog: `❌ getRegion 失败：${JSON.stringify(err)}` });
      }
    });
  }
});


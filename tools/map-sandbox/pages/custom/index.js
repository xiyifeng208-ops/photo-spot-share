// 这一页完全复刻正式项目地图页的结构：自定义导航栏 + 100vh 容器 + 百分比高度地图
Page({
  data: {
    status: '等待事件…'
  },

  onUpdated() {
    this.setData({ status: `updated 已触发 ${new Date().toLocaleTimeString()}` });
  },

  onError(e) {
    this.setData({ status: `error: ${JSON.stringify(e.detail)}` });
  }
});


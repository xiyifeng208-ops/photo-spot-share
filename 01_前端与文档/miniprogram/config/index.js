/**
 * 环境配置。
 * 本地开发：微信开发者工具里勾选「不校验合法域名」，直接把 BASE_URL 指向本机 API。
 * 上线前：把 prod 的域名换成已备案 + HTTPS 的域名，并在小程序后台配置
 *        request 合法域名（API）与 uploadFile 合法域名（COS/CDN）。
 */

const ENV = 'dev'; // 'dev' | 'prod'

/**
 * 真机调试必须用电脑的局域网 IP：手机上的 localhost 指向手机自己，请求会直接失败，
 * 小程序里表现为"网络不可用"。
 *
 * 这里按顺序列全部候选地址，请求不通时会自动换下一个（只在 dev 生效，prod 只用 apiBaseUrl）：
 *   - 10.3.0.103     当前 WLAN 网卡，手机连同一个 Wi-Fi 时用。注意这个地址由 DHCP 分配、
 *                    每次换网络都可能变；公司大网也常开客户端隔离，
 *                    那种情况下手机根本连不到电脑，别浪费时间调它。
 *   - 192.168.137.1  电脑的「移动热点」虚拟网卡，手机连电脑热点时用，最稳。
 * 开发者工具的模拟器两个地址都能访问。
 */
const DEV_API_URLS = ['10.3.0.103', '192.168.137.1'].map(
  (host) => `http://${host}:3000/api/v1`
);

const ENVIRONMENTS = {
  dev: {
    apiBaseUrl: DEV_API_URLS[0],
    fallbackApiBaseUrls: DEV_API_URLS.slice(1),
    // 本地开发没有小程序 AppID 时，用 dev:<设备ID> 登录（后端 AUTH_DEV_MODE=true）
    useDevLogin: true,
    // STORAGE_DRIVER=local 时后端返回本地上传地址，无需 COS
    storageDriver: 'local'
  },
  prod: {
    apiBaseUrl: 'https://api.your-domain.com/api/v1',
    useDevLogin: false,
    storageDriver: 'cos'
  }
};

const current = ENVIRONMENTS[ENV] || ENVIRONMENTS.dev;

module.exports = {
  ENV,
  ...current,
  // 打开后地图页会在顶栏显示一行调试信息（updated 事件次数 / getRegion 结果 / 已等待秒数）。
  // 排查地图渲染问题时才需要打开；演示前保持关闭，否则顶栏会有调试灰字。
  debug: false,
  // 地图默认视角：大陆中心，防止拿不到定位时出现空白地图
  defaultCenter: { latitude: 34.2, longitude: 108.9, scale: 4 },
  // zoom 小于该值时后端返回城市聚合点
  clusterZoomThreshold: 9,
  maxPhotos: 9,
  maxPhotoMB: 10
};

# 旅游拍照机位打卡分享

微信小程序 + NestJS + PostgreSQL/PostGIS 的「拍照机位分享」实现：用户在地图上选点创建打卡点、
上传自己拍的样片并填写拍摄建议，其他用户在地图上浏览这些机位并一键导航过去。

## 目录结构

```
api/            NestJS 后端（鉴权 / 地址代理 / 打卡点 / 上传 / 定时清理）
  migrations/   SQL 迁移（PostGIS、枚举、索引）
  seeds/        本地开发种子数据
miniprogram/    微信小程序（地图 / 发现 / 我的 / 详情 / 创建）
deploy/         docker compose、Dockerfile、nginx、备份脚本
tools/          图标生成脚本
docs/           接口说明、部署手册、里程碑
```

## 核心技术选择

- **渲染用微信原生 `<map>`**（腾讯底图、免 Key），**高德只在服务端**用于逆地理编码与 POI 搜索，Key 不落前端。
- **全链路 GCJ-02**：`wx.getLocation({type:'gcj02'})` 拿到什么就存什么，不做 WGS-84 转换；距离计算也在 GCJ-02 下进行。
- **导航用 `wx.openLocation`**：拉起微信内置地图，含路线规划并可跳转腾讯地图，无需 AppID 白名单。
- **查询分级**：`zoom < 9` 按城市聚合（避免全国视图塞几千个 marker），`zoom >= 9` 走 PostGIS 视野查询，上限 500 条并返回 `truncated`。
- **上传可切换驱动**：默认 `local`（落盘 + `/static`，零云依赖即可跑通全链路），生产切 `cos`（后端下发限定在 `uploads/{userId}/*` 的 10 分钟临时密钥，小程序直传）。

## 本地跑通（不需要任何云账号）

### Windows 便携环境（无需安装，推荐用于当前项目目录）

仓库根目录提供了完全放在项目内的运行环境。首次准备或需要修复环境时执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-portable.ps1
```

脚本会把 Node、pnpm、PostgreSQL/PostGIS、依赖、数据库和缓存放进被 Git 忽略的 `.local/`，
不会安装系统软件或修改系统 PATH。准备完成后：

- 双击 `start-local.cmd`：启动数据库与后端，窗口保持打开。
- 打开 `http://localhost:3000/health`：应返回 `status: ok`。
- 双击 `stop-local.cmd`：安全停止便携数据库。

便携数据库固定监听 `127.0.0.1:55432`，API 监听 `3000`；小程序真机地址在
`miniprogram/config/index.js` 中配置。

### Docker 环境（另一种选择）

前置：Docker（用于起 PostGIS）、Node 22+。

```bash
# 1. 起数据库
docker compose -f deploy/docker-compose.yml up -d postgres

# 2. 后端
cd api
cp .env.example .env          # 默认 STORAGE_DRIVER=local、AUTH_DEV_MODE=true，可直接用
pnpm install
pnpm migrate                  # 建表 + PostGIS 扩展
pnpm seed                     # 可选：灌 6 个演示机位
pnpm start:dev                # http://localhost:3000/api/v1

# 3. 自测
curl http://localhost:3000/health
```

```bash
# 4. 小程序
# 微信开发者工具导入 miniprogram/ 目录
# 详情 → 本地设置 → 勾选「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」
# 编译后即为 dev 环境：config/index.js 里 useDevLogin=true，用 dev:<设备ID> 静默登录
```

## 测试

```bash
cd api
pnpm typecheck
pnpm test                     # 单元测试：坐标/游标/限流/上传校验/业务分支，无需数据库

# 端到端（需要 PostGIS）：覆盖 申请凭证 → 上传 → 发布 → 地图可见 → 详情 → 越权 403 → 软删 404
TEST_DATABASE_URL=postgres://spot:spot@localhost:5432/spot pnpm test -- spots.e2e
```

在项目根目录还有一条命令的分层自检（缺数据库时自动跳过数据库层，不会误报失败）：

```bash
node tools/verify-local.mjs --db "postgres://spot:spot@localhost:5432/spot"
```

完整步骤、便携版 PostGIS 的搭法、常见报错见 [docs/LOCAL-VERIFY.md](docs/LOCAL-VERIFY.md)。

## 上线

按 [docs/DEPLOY.md](docs/DEPLOY.md) 走：服务器 → 备案域名 + HTTPS → COS → 高德 Key →
小程序后台配置 request/uploadFile 合法域名 → 申请 `wx.getLocation` 接口 → 提审。
接口细节见 [docs/API.md](docs/API.md)，里程碑与验收标准见 [docs/MILESTONES.md](docs/MILESTONES.md)。

## v1 范围与已知取舍

- 只做**创建 / 浏览 / 导航**，不含点赞、评论、关注。
- **不做内容审核**：微信对 UGC 小程序要求内容安全机制，提审存在被驳回风险。
  代码里已留好钩子 —— 把 `CONTENT_CHECK_ENABLED=true` 并在 `ContentCheckService` 补图片检测即可，
  命中风险的内容会被置为 `hidden` 等待人工确认。
- 坐标**精确公开**，热门机位可能被人流挤爆；v1.1 建议加「坐标模糊化 / 仅导航时下发」开关。
- 仅支持中国大陆坐标（境外点会被 400 拒绝）。
- 单实例 + 单库设计，适配冷启动几千个打卡点；量级上来再引入 Redis 缓存与读写分离。

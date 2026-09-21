# 部署手册

## 0. 需要先准备好的东西

| 项目 | 说明 |
| --- | --- |
| 云服务器 | 腾讯云轻量 2C4G / Ubuntu 22.04，系统盘 ≥ 60G |
| 域名 | 已完成 **ICP 备案**（小程序硬性要求），建议 `api.example.com` |
| SSL 证书 | 免费 DV 证书即可，放到 `deploy/nginx/certs/{fullchain.pem,privkey.pem}` |
| COS 存储桶 | 私有读写 + CDN 加速域名，建议单独建 RAM 子账号，权限只给该桶 `uploads/` 前缀 |
| 高德 Key | 开放平台创建应用，Key 类型必须选 **Web服务**（见下一节） |
| 小程序 | 企业主体 AppID；在「开发 → 接口设置」申请开通 `wx.getLocation` |

## 高德 Key 常见报错对照

逆地理编码用的是「Web服务」类型的 Key，填在后端 `api/.env` 的 `AMAP_KEY`。填错类型是最常见的问题，
后端会把高德的错误码翻译成人话返回给前端，日志里同时保留原始错误码。

| 高德返回 | 含义 | 怎么处理 |
| --- | --- | --- |
| `INVALID_USER_KEY` | Key 无效或已过期 | 检查 `.env` 里的 `AMAP_KEY` 是否复制完整 |
| `USERKEY_PLAT_NOMATCH` | Key 与调用平台不匹配 | **创建 Key 时服务平台必须选「Web服务」**，不能选「Web端(JS API)」或「微信小程序」 |
| `SERVICE_NOT_AVAILABLE` | 该 Key 没开通 Web 服务 | 到高德控制台确认 Key 的服务类型 |
| `INVALID_USER_SCODE` | 账号未实名认证 | 到高德控制台完成个人/企业认证，未认证额度极低 |
| `DAILY_QUERY_OVER_LIMIT` | 当日配额用完 | 等次日恢复，或更换额度更高的账号；后端已有 10 分钟缓存可省配额 |
| `INVALID_USER_IP` | 服务器 IP 不在白名单 | 在 Key 的配置里去掉 IP 限制，或加入服务器公网 IP |

改完 `AMAP_KEY` 后**必须重启后端**（`.env` 只在启动时读一次），Windows 上双击 `api/restart.cmd` 即可。
验证：`/geo/reverse` 需要登录态（防止匿名请求消耗配额），**不能直接在浏览器打开**（会返回 401）。
用 `node tools/check-amap.mjs` 会自动用 dev 账号换 token 再调用并给出结论；
或者在开发者工具里进「创建机位」拖动地图，看地址栏是否自动出现地名。

## 1. 服务器初始化

```bash
# 安装 Docker 与 compose 插件（官方脚本）
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker
mkdir -p /opt/photo-spot-share && cd /opt/photo-spot-share
# 上传仓库（git clone 或 scp）
cp deploy/.env.example deploy/.env && vim deploy/.env
```

`deploy/.env` 里几个必须改的项：

- `JWT_SECRET`：`openssl rand -hex 32`
- `POSTGRES_PASSWORD`：强密码
- `PUBLIC_BASE_URL` / `DATABASE_URL` 中的域名与密码保持一致
- `AUTH_DEV_MODE=false`（生产禁止 dev 登录）
- `WX_APPID` / `WX_SECRET` / `AMAP_KEY`
- `STORAGE_DRIVER=cos` 时补齐 `COS_*` 与 `CDN_BASE_URL`
- `CONTENT_CHECK_ENABLED=true`（打开内容机审）与 `WX_CALLBACK_TOKEN`（消息推送 Token）
- `ADMIN_TOKEN`（运营接口令牌，留空则运营接口关闭）

## 2. 启动

```bash
cd /opt/photo-spot-share/deploy
docker compose up -d --build
docker compose logs -f api
curl https://api.example.com/health
```

`api` 容器启动时会先执行迁移（`node dist/database/run-migrations.js`）再启动服务，迁移可重复执行。
首次想灌一些演示数据：

```bash
docker compose exec api node dist/database/run-seed.js
```

## 3. 小程序侧配置

1. `miniprogram/config/index.js`：`ENV` 改为 `'prod'`，并把 `prod.apiBaseUrl` 换成正式域名。
2. 小程序管理后台 →「开发管理 → 开发设置 → 服务器域名」：
   - `request 合法域名`：`https://api.example.com`
   - `uploadFile 合法域名`：本地驱动时同 API 域名；COS 驱动时填 COS/CDN 域名
   - 都必须 HTTPS，且域名已备案
3. 「开发 → 接口设置」申请 `wx.getLocation`，用途填写：*用于在地图上定位用户附近的拍摄机位并计算导航距离*。
4. 用户隐私保护指引里声明：收集位置信息、照片，用途与上面的描述一致。
5. 若走 COS 直传：`cd miniprogram && npm i cos-wx-sdk-v5`，用微信开发者工具「工具 → 构建 npm」。

## 4. 备份与监控

```bash
# 每天 3:10 备份数据库，可选上传 COS
chmod +x deploy/scripts/backup-db.sh
crontab -e
10 3 * * * /opt/photo-spot-share/deploy/scripts/backup-db.sh >> /var/log/spot-backup.log 2>&1
```

- 容器重启策略已设为 `unless-stopped`，服务器重启后自动恢复。
- `GET /health` 返回 `database: down` 时先看 `docker compose logs postgres`。
- 磁盘占用主要来自本地驱动上传的图片：`docker system df` 与 `var/uploads` 目录。
  切到 COS 驱动后本地只保留少量缓存，运维压力显著下降。

## 5. 上线自检清单

- [ ] `/health` 返回 `status: ok`
- [ ] 真机能定位、能创建机位、能看到自己刚发的点
- [ ] 创建机位时**地址自动带出**（`/geo/reverse` 返回 `source: amap`），发布后详情页有省市地址
- [ ] 详情页「导航到这里」能拉起微信内置地图
- [ ] `AUTH_DEV_MODE=false`，用真实 `wx.login` 能换取 token
- [ ] 图片 URL 走 CDN 域名（或正确的外网地址）且能正常显示
- [ ] 提交内容后数据库 `spots.status` 为 `active`
- [ ] `pg_dump` 备份任务已跑通一次

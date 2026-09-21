# 部署手册

## 0. 需要先准备好的东西

| 项目 | 说明 |
| --- | --- |
| 云服务器 | 腾讯云轻量 2C4G / Ubuntu 22.04，系统盘 ≥ 60G |
| 域名 | 已完成 **ICP 备案**（小程序硬性要求），建议 `api.example.com` |
| SSL 证书 | 免费 DV 证书即可，放到 `deploy/nginx/certs/{fullchain.pem,privkey.pem}` |
| COS 存储桶 | 私有读写 + CDN 加速域名，建议单独建 RAM 子账号，权限只给该桶 `uploads/` 前缀 |
| 高德 Key | 开放平台创建应用，Key 类型必须选 **Web服务** |
| 小程序 | 企业主体 AppID；在「开发 → 接口设置」申请开通 `wx.getLocation` |

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
- [ ] 详情页「导航到这里」能拉起微信内置地图
- [ ] `AUTH_DEV_MODE=false`，用真实 `wx.login` 能换取 token
- [ ] 逆地理编码返回 `source: amap`（不是 `unavailable`）
- [ ] 图片 URL 走 CDN 域名且能正常显示
- [ ] 提交内容后数据库 `spots.status` 为 `active`
- [ ] `pg_dump` 备份任务已跑通一次


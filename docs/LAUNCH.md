# 正式上线清单

面向所有人开放前要办的事。**代码侧的合规能力已经做完**（内容机审、举报处置、协议页面、运营接口），
下面这些是必须由你（企业主体）去办的外部事项，以及上线前的验收步骤。

## 一、采购（先把域名买下来开始备案）

| 项目 | 建议规格 | 估算（以腾讯云官网为准） |
| --- | --- | --- |
| 域名 | .com / .cn 均可，用于 `api.你的域名` | 首年 60–80 元，续费约 80 元/年 |
| 云服务器 | 轻量应用服务器 2C4G，Ubuntu 22.04 | 新用户 100–300 元/年，常规 600–1000 元/年 |
| SSL 证书 | 免费 DV 证书 | 0 元 |
| COS + CDN | 图片存储与分发，起步 50GB 以内 | 约 10–30 元/月（主要是 CDN 流量） |
| 微信认证 | 企业主体小程序建议认证 | 300 元/年 |

## 二、资质与备案（有先后依赖，备案是硬等待）

1. **买域名 → 立即提交 ICP 备案**（7–20 个工作日）。
2. 买服务器（备案期间就能部署，用 IP 自测）。
3. **小程序备案**：2024 年起新小程序上架前必须完成，在小程序后台按指引提交。它和域名备案是两件事，别漏。
4. 从后台拿到 `WX_APPID` / `WX_SECRET` 填进服务器 `.env`。

## 三、小程序后台配置

| 位置 | 要配什么 |
| --- | --- |
| 开发管理 → 开发设置 → 服务器域名 | request 合法域名填 `https://api.你的域名`；uploadFile 合法域名填 COS/CDN 域名 |
| 开发 → 接口设置 | 申请 `wx.getLocation`，用途：定位用户附近机位并计算导航距离 |
| 功能 → 用户隐私保护指引 | 声明收集：位置信息、相册照片、微信昵称头像；用途与上面的描述保持一致 |
| 开发管理 → 消息推送 | 图片机审结果靠它回传：URL 填 `https://api.你的域名/api/v1/wechat/callback`，Token 与后端 `WX_CALLBACK_TOKEN` 一致，数据格式 JSON，加密方式选明文模式 |
| 设置 → 基本设置 → 服务类目 | 优先「工具 - 信息查询」或「旅游」；本产品没有评论/关注/私信，工具属性更强，比「社交-社区/论坛」更容易过审 |

## 四、服务器配置（部署时对照）

对照 `deploy/.env.example` 修改 `deploy/.env`：

    NODE_ENV=production
    AUTH_DEV_MODE=false            # 生产必须关闭 dev 登录
    STORAGE_DRIVER=cos             # 图片走对象存储
    CDN_BASE_URL=https://cdn.你的域名
    PUBLIC_BASE_URL=https://api.你的域名
    WX_APPID=...                   # 小程序后台获取
    WX_SECRET=...
    WX_CALLBACK_TOKEN=...          # 与消息推送里填的 Token 一致
    AMAP_KEY=...                   # 已有，直接沿用
    JWT_SECRET=...                 # openssl rand -hex 32
    CONTENT_CHECK_ENABLED=true     # 打开内容机审（文本 + 图片）
    ADMIN_TOKEN=...                # openssl rand -hex 16，用于运营接口

小程序端：`miniprogram/config/index.js` 把 `ENV` 改成 `'prod'`、填好 `prod.apiBaseUrl`，并把 `debug` 改为 `false`。

## 五、上线前验收（体验版真机走一遍）

- `/health` 返回 `status: ok`、`database: up`
- 打开小程序即静默登录成功（无需输入账号）
- 创建机位：地址自动带出、能选拍摄参数、发布后**我的页显示"审核中"**
- 机审通过后自动公开：地图上能看到、发现页按城市筛选也能看到
- 文本或图片命中风险时，机位保持隐藏（不公开给别人）
- 举报入口：非作者可见；举报后按阈值（3 个不同用户）自动下线
- 运营接口可用（带 `x-admin-token`）：`GET /api/v1/admin/reports`
- 导航能拉起微信内置地图；图片走 CDN 域名正常显示
- 备份任务跑通一次（`deploy/scripts/backup-db.sh`）
- 提审备注写明「打开即静默登录，无需账号密码」，省掉审核员索要测试账号的来回

## 六、运营接口速查（无界面）

    # 查看待处理举报
    curl -H "x-admin-token: $ADMIN_TOKEN" https://api.你的域名/api/v1/admin/reports

    # 恢复被误伤的机位 / 手动下线 / 删除（status 取 active | hidden | deleted）
    curl -X POST -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" -d "{\"status\":\"active\"}" https://api.你的域名/api/v1/admin/spots/<机位ID>/status

    # 结掉某个机位的举报（resolution 取 resolved | rejected）
    curl -X POST -H "x-admin-token: $ADMIN_TOKEN" -H "content-type: application/json" -d "{\"resolution\":\"resolved\"}" https://api.你的域名/api/v1/admin/spots/<机位ID>/resolve-reports

    # 手动触发机审超时兜底
    curl -X POST -H "x-admin-token: $ADMIN_TOKEN" https://api.你的域名/api/v1/admin/content-check/sweep

## 七、协议文本待补

`miniprogram/pages/legal/index.js` 顶部的三个常量是占位符，上线前必须替换成真实信息：

- `COMPANY`：公司全称
- `CONTACT`：联系邮箱
- `EFFECTIVE_DATE`：生效日期

替换后，把同样的内容同步到小程序后台的《用户隐私保护指引》。


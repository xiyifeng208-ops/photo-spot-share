# 本地验证指南

## 一条命令

在项目根目录执行下面这条命令，它会按六步做分层自检；没有数据库时只跳过数据库相关步骤，不会整体报失败。

    node tools/verify-local.mjs
    node tools/verify-local.mjs --db "postgres://spot:spot@localhost:5432/spot"
    node tools/verify-local.mjs --skip-install

Windows 上如果 PATH 里没有 Node，可以用 Codex 内置运行时直接跑：

    C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe tools\verify-local.mjs

## 六步分别在验什么

| 步骤 | 验证内容 |
| --- | --- |
| 1 环境 | Node / pnpm 版本，是否装了 Docker |
| 2 依赖 | pnpm install（缺 node_modules 时自动安装） |
| 3 静态检查 | tsc 类型检查、单元测试、生产构建 |
| 4 数据库准备 | 执行迁移（建表 + PostGIS 扩展）、写入演示数据 |
| 5 接口行为 | 真实启动服务，用 HTTP 断言校验错误码与统一错误体 |
| 6 端到端 | 申请凭证 → 上传图片 → 发布 → 地图可见 → 详情 → 越权 403 → 软删 404 |

## 页面级离线回归（不需要开发者工具）

用桩件替换 `wx` API，直接跑页面真实代码，覆盖那些只有在真机/模拟器上才会暴露的问题：

    node tools/test-map-page.mjs        # 地图页：不回调、延迟就绪、返回页、缩放、getRegion 抖动
    node tools/test-discover-page.mjs   # 发现页：定位慢时先出列表、自动切城市、候选地址切换
    node tools/test-create-page.mjs     # 创建页：手填地址、多选高亮、地址服务失败提示

## 数据库从哪来

方案 A（推荐）：Docker。执行 `docker compose -f deploy/docker-compose.yml up -d postgres`，
再用默认连接串跑自检即可。

方案 C：云上 PostgreSQL 开启 PostGIS 扩展，把连接串传给 `--db`。注意迁移会执行
`CREATE EXTENSION postgis`，账号需要有相应权限。

方案 B：没有 Docker 时用免安装便携版，见下一节。

## 方案 B：免安装便携版 PostGIS

Windows 已提供自动化便携环境，不需要手工下载、解压或配置 PATH。在仓库根目录执行：

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-portable.ps1

所有运行时和数据都在 `.local/`：Node 22、项目内 pnpm、PostgreSQL 16 + PostGIS、依赖缓存、
数据库数据和日志。该目录已被 Git 忽略。脚本会校验官方归档、合并扩展、初始化 55432 端口、
迁移和种子数据，并运行完整后端/E2E及页面离线回归。

日常使用：

    start-local.cmd       # 启动数据库和 API（http://localhost:3000）
    stop-local.cmd        # 安全停止项目自己的数据库

手动复跑自检时使用项目内 Node，并明确传入便携数据库：

    .\.local\node\node.exe tools\verify-local.mjs --skip-install --db "postgres://spot@127.0.0.1:55432/spot"

启动脚本只操作 `.local/pgdata` 对应的实例；若 55432 或 3000 被其他程序占用会直接报错，不会结束未知进程。

## 界面验证（必须在微信开发者工具里做）

接口全绿只代表后端没问题，地图和表单要人眼看：

1. 微信开发者工具导入 `miniprogram` 目录，AppID 用自己的。
2. 详情 → 本地设置 → 勾选「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」。
3. 逐项确认：默认进「发现」页并能看到机位卡片；切到「地图」Tab 能按视野拉点、低缩放变城市聚合气泡；
   创建流程能拖动选点、地址自动带出（配了高德 Key 时）、发布后跳详情；详情页「导航到这里」能拉起微信内置地图。

## 常见报错

| 现象 | 原因与处理 |
| --- | --- |
| 数据库连接失败 ECONNREFUSED | 数据库没起或端口不对；/health 会显示 database: down |
| type geography does not exist | 连的是不带 PostGIS 的普通 PostgreSQL，换镜像或装扩展 |
| pg_ctl: could not create restricted token | 受限环境无法降权，直接跑 postgres -D pgdata |
| 地址显示"未接入逆地理编码" | 后端没配 `AMAP_KEY`；配了还报错就看 `docs/DEPLOY.md` 的报错对照 |
| 真机提示"网络不可用" | 手机上的 localhost 是手机自己，把 `config/index.js` 的候选地址改成电脑局域网 IP；或在真机调试面板勾选「不校验合法域名」 |
| curl/git 报 schannel SEC_E_NO_CREDENTIALS | 本机 TLS 凭证异常，改用 Node 下载或给 git 设 `http.sslBackend=openssl` |

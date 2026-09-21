[README.md](https://github.com/user-attachments/files/32485369/README.md)
# 旅游摄影机位分享小程序

面向旅行者和摄影爱好者的微信小程序：分享“在哪里拍、什么时候拍、怎么到达”，通过城市搜索、拍摄条件筛选、收藏清单和精选路线找到合适的机位。

功能版本：**1.5**。本文更新：2026-09-22。

> 首次复现建议使用下面的 Windows 便携方案。无需预装 Node、Git、Docker，也不需要 Codex。GitHub 提供的是源码，不包含原开发者的数据库、照片、密钥和运行环境。

## 已实现功能

- **发现机位**：大陆城市选择、位置/作品名称搜索，拍摄时段、季节、焦段、到达难度多选筛选；有搜索关键词时按收藏数优先排序，没有关键词时按发布时间排序。
- **发布与编辑**：选点、地区与地址确认、照片上传、拍摄建议；新发布支持本机草稿，最多 10 份/账号，草稿照片总量上限 100 MB。
- **收藏与出行**：作品详情收藏、我的想去清单、城市筛选、导航与坐标复制；地图浏览保持独立。
- **摄影参考**：精选摄影路线、近 30 天机位条件反馈、日出日落及黄金/蓝调时段参考。

技术栈：微信原生小程序 + NestJS / TypeScript + PostgreSQL / PostGIS。地图使用微信原生组件；高德用于服务端地址解析和地点查询，Key 不进入小程序。坐标使用 GCJ-02。

## 一、Windows 快速复现

### 1. 下载源码和微信开发者工具

准备 Windows x64 电脑、可联网环境及数 GB 可用磁盘空间。在 GitHub 点击 **Code → Download ZIP**，解压完整项目。项目根目录应能看到 `api`、`miniprogram` 和 `setup-portable.ps1`。

安装并登录 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)。它需要单独安装，不包含在项目初始化脚本中。

以下命令均在**项目根目录**执行：打开该目录，在资源管理器地址栏输入 `powershell` 并回车。目录不要求与原作者相同。

### 2. 首次初始化后端

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-portable.ps1
```

首次需要下载依赖，请等待脚本结束。脚本会：

- 下载 Node.js 22.23.2、pnpm 9.15.9、PostgreSQL 16.15 和 PostGIS 3.6.2。
- 在项目内创建 `.local/`，存放便携程序、数据库、下载、缓存和日志；后端依赖位于 `api/node_modules/`。
- 生成本机 `api/.env`，启用开发登录、本地图片存储，关闭内容审核。
- 执行数据库迁移；仅当作品表为空时写入 6 个演示机位。
- 执行类型检查、测试和构建；数据库测试使用独立测试库。

不安装系统服务，不修改系统 PATH 或注册表。默认下载来自官方 Node、EDB、OSGeo 及 npm 包源。

下载中断后可重新执行。需要跳过测试时可追加 `-SkipChecks`，但仍会安装依赖、迁移和构建。脚本重复运行会重新设置部分**本地开发配置**，不要用于生产环境；日常启动不必重复初始化。

### 3. 启动并检查后端

双击根目录 **`start-local.cmd`**，等待数据库就绪、迁移完成及 API 启动，保持窗口打开。

浏览器访问 [http://localhost:3000/health](http://localhost:3000/health)，应包含：

```json
{ "data": { "status": "ok", "database": "up" } }
```

实际响应还包含其他字段。`status: degraded` / `database: down` 表示数据库连接异常，不算启动成功。

| 服务 | 本地配置 |
| --- | --- |
| API | `http://localhost:3000/api/v1` |
| 健康检查 | `http://localhost:3000/health` |
| PostgreSQL | `127.0.0.1:55432`，用户和数据库均为 `spot` |

便携数据库采用仅本机访问的开发认证配置，不要开放到局域网或公网。启动统一使用根目录脚本，不使用旧的 `api/restart.cmd`。

### 4. 修改小程序的后端地址

在 PowerShell 执行 `ipconfig`，找到电脑当前 Wi-Fi 或以太网的 **IPv4 地址**，例如 `192.168.1.100`。

打开 [miniprogram/config/index.js](miniprogram/config/index.js)，保留 `ENV = 'dev'`，把 `DEV_API_URLS` 改成自己的电脑地址：

```javascript
// 示例 IP 必须替换；保留端口和 /api/v1 后缀。
const DEV_API_URLS = ['192.168.1.100'].map(
  (host) => `http://${host}:3000/api/v1`
);
```

仅在电脑模拟器调试时可用 `127.0.0.1`；**手机上不能用 localhost / 127.0.0.1 访问电脑**。源码中原作者的 IP 不适用于其他电脑。使用电脑热点时，也应确认实际热点网卡地址后再填写。

### 5. 导入小程序

1. 在微信开发者工具选择“导入项目”，目录选择 **`miniprogram/`**，不是项目根目录。
2. 使用自己的小程序 AppID，并确保当前微信账号有对应开发权限；不要沿用原作者的 AppID。必要时修改 `miniprogram/project.config.json`。
3. 本地开发时，在“详情 → 本地设置”勾选“不校验合法域名、web-view、TLS 版本以及 HTTPS 证书”。此设置不用于正式上线。
4. 点击“编译”。当前开发配置使用模拟登录，无需填写真实微信登录 Secret。

开发登录只替代本项目的后端登录，**不会绕过微信对 AppID、定位等接口的权限要求**。测试号能否使用特定能力取决于平台支持情况。

初始演示数据包含上海、杭州和重庆的机位，无照片时显示占位图。若定位后的城市没有作品，切换“全部城市”查看。演示作品属于演示作者，新账号的“我发布的”为空是正常现象。

### 6. 手机验证

1. 手机与电脑连接同一 Wi-Fi，或手机连接电脑共享热点。
2. 先用手机浏览器访问 `http://电脑IPv4:3000/health`，确认 `ok` / `up`。
3. 在开发者工具点击“预览”或“真机调试”，按提示用手机微信扫码。
4. 如提示合法域名问题，检查当前真机调试模式的域名校验设置；正式体验版/上线需要合规 HTTPS 域名，不能照搬本地 HTTP 方案。

如果电脑能访问而手机不能，检查 IP 是否变化、Wi-Fi 是否开启客户端隔离，以及 Windows 防火墙。需要放行时仅允许私有网络中的 Node/API 端口 `3000`，不要关闭整个防火墙，也不需要开放数据库端口。

## 二、高德 Key 配置（可选）

不配置高德也可手动确认地区和详细地址。需要自动地址解析与地点查询时：

1. 按 [高德官方说明](https://lbs.amap.com/api/webservice/guide/create-project/get-key) 创建应用和 **Web 服务**类型 Key。
2. 编辑本机 `api/.env`，填写：

   ```dotenv
   AMAP_KEY=你的Web服务Key
   ```

3. 停止并重新启动后端，再从项目根目录执行检查：

   ```powershell
   .\.local\node\node.exe .\tools\check-amap.mjs
   ```

Key 只保存在后端 `.env`，不要放进小程序或上传 GitHub。微信原生地图、日出日落计算不依赖这个 Key。

## 三、日常调试与换电脑

- **开始开发**：双击 `start-local.cmd`，再打开微信开发者工具。后端源码通常由开发模式自动重载；小程序修改后点击编译。
- **修改环境变量**：改完 `api/.env` 后重启后端。
- **停止项目**：在后端窗口按 `Ctrl+C`，如询问终止批处理则确认；再双击 `stop-local.cmd` 安全停止数据库。停止脚本不负责关闭 API。
- **换电脑/重新下载**：重新执行“一、Windows 快速复现”，使用新电脑 IP、自己的 AppID 和 Key。不要直接复用旧电脑的绝对路径。

源码不等于数据备份：数据库保存在 `.local/pgdata/`，本地上传图片通常在 `api/var/uploads/`；迁移旧数据时需要同时备份数据库和图片，具体记录见 [RUNBOOK.md](RUNBOOK.md)。不要只复制运行中的数据库目录。

草稿只保存在当前设备的小程序文件系统，不上传服务器。不同开发账号的收藏不会自动合并；清除小程序数据可能丢失草稿和本机开发身份。

建议依次验收：

1. 选择“全部城市”浏览，再选上海搜索“外滩”，尝试组合拍摄条件。
2. 进入作品详情收藏，在“我的 → 想去清单”找到并取消。
3. 新建作品、填写内容和照片，保存草稿后退出，再从草稿箱恢复。
4. 打开精选摄影路线，进入机位详情，检查收藏、导航及摄影时段参考。

## 四、测试与构建

首次初始化默认运行完整检查。已有环境日常修改后，可在项目根目录的 PowerShell 执行：

```powershell
# 只设置当前 PowerShell 会话，不修改系统环境变量。
$project = (Get-Location).Path
$env:PATH = "$project\.local\node;$env:PATH"
$env:TEMP = "$project\.local\tmp"
$env:TMP = $env:TEMP
$env:npm_config_cache = "$project\.local\npm-cache"
$env:PNPM_STORE_DIR = "$project\.local\pnpm-store"

.\.local\pnpm\pnpm.cmd --dir api typecheck
.\.local\pnpm\pnpm.cmd --dir api run test --testPathIgnorePatterns e2e
.\.local\pnpm\pnpm.cmd --dir api build
.\.local\node\node.exe .\tools\test-favorite-counts.mjs
```

以上依次为类型检查、不依赖数据库的后端测试、生产构建和收藏数页面回归。其他页面回归脚本位于 `tools/test-*.mjs`。

数据库端到端测试必须使用**独立测试库**，数据库名要求以 `spot_test_` 开头；初始化脚本会自动创建并使用隔离测试库。手动运行时通过 `TEST_DATABASE_URL` 指定测试库，或使用 `tools/verify-local.mjs` 的 `--db` 参数，详细配置见 [本地验证说明](docs/LOCAL-VERIFY.md)。

> 不要把日常 `spot` 数据库交给测试命令，也不要在已有作品的库上随意运行 `pnpm seed`：种子脚本会删除并重建固定 ID 的演示作品。启动脚本只执行增量迁移，不重跑种子数据。

历史完整验证记录：2026-09-18，后端 489 项、页面回归 413 项通过，类型检查与生产构建通过。这是当时的验证结果，不代表你的新电脑已经通过检查。

## 五、常见问题

| 现象 | 处理方式 |
| --- | --- |
| 提示找不到 `node` 或 `pnpm` | 无需全局安装；使用本文的 `.local` 路径，或根目录启动脚本。 |
| 初始化下载失败 | 检查网络与磁盘空间，重跑初始化；保留已有 `.local`，不要直接删除数据库。 |
| 提示存在 `api/.env.local` | 该文件优先级更高；先备份并核对其内容，按脚本提示消除配置冲突，不要覆盖自己的 Key。 |
| 没有后端窗口 | 手动双击根目录 `start-local.cmd`；微信开发者工具不会自动启动后端。 |
| 提示 `3000` 已占用 | 可能已有 API 在运行；先检查健康接口和原窗口，不要反复启动或随意结束未知进程。 |
| 健康接口显示数据库 `down` | 查看启动窗口及 `.local/logs/`，确认数据库已启动，连接使用 `127.0.0.1:55432/spot`。 |
| 手机无法访问，电脑正常 | 核对电脑 IPv4、同一网络、防火墙和 Wi-Fi 隔离；先让手机浏览器健康检查成功。 |
| AppID 无权限或定位失败 | 使用自己的 AppID、开发者账号及所需平台权限；同时检查手机定位授权。 |
| 新电脑没有原来的作品/照片 | GitHub 不保存原开发数据库和上传照片，需另行迁移备份。 |
| “我的”为空或不同设备收藏不同 | 初始演示作品不是当前账号发布；收藏按后端用户身份隔离。 |

## 六、目录与进一步阅读

```text
api/                    NestJS API、数据库迁移、依赖配置
miniprogram/            微信小程序源码及开发地址配置
deploy/                 Docker、Nginx 与部署配置
tools/                  检查、回归测试、文档生成等工具
docs/                   接口、功能、部署与演示说明
.local/                 本机便携环境与数据（不提交）
setup-portable.ps1      首次初始化
start-local.cmd         日常启动数据库和 API
stop-local.cmd          安全停止数据库
RUNBOOK.md              原开发环境运行、换机与版本记录
```

- [功能介绍正文](docs/FEATURES.md) / [Word 功能介绍](项目功能介绍.docx)
- [API 接口说明](docs/API.md)
- [精选路线配置与维护](docs/ROUTES.md)
- [摄影时段计算说明](docs/SHOOTING-TIMES.md)
- [比赛演示流程](docs/DEMO.md)
- [运行与换机记录](RUNBOOK.md)
- [部署说明](docs/DEPLOY.md)

便携脚本面向 Windows x64。其他系统需要自行准备兼容的 Node、pnpm、PostgreSQL/PostGIS，可参考 `deploy/`；Docker/手动环境的数据库端口与认证需以自己的配置为准，不能直接套用便携版的 `55432`。

## 七、开发与上线边界

- 本地配置启用模拟登录、HTTP 和本地图片存储，内容审核默认关闭。正式上线需要真实微信登录、HTTPS、合法域名、权限及内容安全配置，不能直接公开开发环境。
- 精选路线标注为演示编排，未经实地验证；条件反馈是用户提供的信息，摄影时段是计算参考，不是实时天气或安全保证。
- 暂不包含管理后台、自由评论、自动路线规划、路线收藏和支付；发现页筛选不会自动联动地图。
- 不要提交真实 `.env`、密钥、数据库备份、用户上传照片、`.local/`、`node_modules/` 或 `project.private.config.json`；保留 `.env.example` 作为配置模板。
- 使用 GitHub 网页上传时也要手动排除私密文件，不能依赖 `.gitignore` 替网页筛选。上传代码不会自动部署 API，也不会同步本地数据。

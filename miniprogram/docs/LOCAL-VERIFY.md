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

## 数据库从哪来

方案 A（推荐）：Docker。执行 `docker compose -f deploy/docker-compose.yml up -d postgres`，
再用默认连接串跑自检即可。

方案 C：云上 PostgreSQL 开启 PostGIS 扩展，把连接串传给 `--db`。注意迁移会执行
`CREATE EXTENSION postgis`，账号需要有相应权限。

方案 B：没有 Docker 时用免安装便携版，见下一节。

## 方案 B：免安装便携版 PostGIS

用 PostgreSQL 官方便携二进制 + OSGeo 的 PostGIS 打包件，解压即用，不需要管理员权限。
关键点是 PostGIS bundle 的 bin/lib/share 要合并进 PostgreSQL 的 pgsql 目录。

下载地址：

    https://get.enterprisedb.com/postgresql/postgresql-16.4-1-windows-x64-binaries.zip
    https://download.osgeo.org/postgis/windows/pg16/postgis-bundle-pg16-3.6.2x64.zip

解压合并（Windows 用 xcopy，macOS/Linux 用 cp -r）：

    mkdir pg && tar -xf postgresql-binaries.zip -C pg
    tar -xf postgis-bundle-pg16-3.6.2x64.zip -C pg
    xcopy /E /Y pg\postgis-bundle-pg16-3.6.2x64\* pg\pgsql\

初始化并启动。注意在受限环境里 pg_ctl 会因权限降级失败，直接用 postgres 命令启动即可：

    pg/pgsql/bin/initdb -D pgdata -U spot -A trust -E UTF8 --locale=C
    echo "port = 55432" >> pgdata/postgresql.conf
    pg/pgsql/bin/postgres -D pgdata
    pg/pgsql/bin/createdb -h 127.0.0.1 -p 55432 -U spot spot

最后带上连接串自检：

    node tools/verify-local.mjs --db "postgres://spot@127.0.0.1:55432/spot"

本机已经按这个方式装好了：便携版 PostgreSQL 在 work/pg，数据目录在 work/pgdata，端口 55432。
重开机后重新启动数据库（在会话根目录执行，终端要保持开着）：

    work\pg\pgsql\bin\postgres.exe -D work\pgdata

停止就是关掉那个终端窗口，或对进程按 Ctrl+C。

## 界面验证（必须在微信开发者工具里做）

接口全绿只代表后端没问题，地图和表单要人眼看：

1. 微信开发者工具导入 miniprogram 目录，AppID 选「测试号」。
2. 详情 → 本地设置 → 勾选「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」。
3. 后端起在 3000 端口：cd api 然后 pnpm start:dev，.env 里的 DATABASE_URL 指向同一个库。
4. 逐项确认：地图能定位并看到种子数据里的 6 个机位；缩小到全国视图会变成「城市 数量」聚合气泡；
   拖动选点 → 地址栏出现地名 → 填表、加照片、发布 → 跳详情；详情页「导航到这里」能拉起微信内置地图；
   发现页能按城市筛选并上拉分页，我的页能编辑和删除。

## 常见报错

| 现象 | 原因与处理 |
| --- | --- |
| 数据库连接失败 ECONNREFUSED | 数据库没起或端口不对；/health 会显示 database: down |
| type geography does not exist | 连的是不带 PostGIS 的普通 PostgreSQL，换镜像或装扩展 |
| pg_ctl: could not create restricted token | 受限环境无法降权，直接跑 postgres -D pgdata |
| curl: (35) schannel: SEC_E_NO_CREDENTIALS | 本机 TLS 凭证异常，改用 Node 下载或浏览器下载 |
| 真机预览连不上后端 | localhost 在手机上指向手机自己，改用局域网 IP 并放行端口 |

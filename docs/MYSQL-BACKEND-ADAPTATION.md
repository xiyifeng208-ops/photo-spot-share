# MySQL 后端适配阶段

本阶段增加 MySQL 支持，仍保留 PostgreSQL。没有修改实际 `.env`、旧数据库、备份或远程数据库；本阶段不是数据迁移或上线切换。

## 选择数据库

`DATABASE_URL` 使用 `postgres://` / `postgresql://` 时保留原有 PostgreSQL 查询路径；使用 `mysql://` 时走新的 MySQL 驱动和查询路径。不需要修改前端 API。

配置参考 `api/.env.mysql.example`，不要现在覆盖实际 `.env`。远程 MySQL 默认要求 `DATABASE_SSL=true`，验证 CA 信任链及连接主机名；可通过 `DATABASE_SSL_CA` 指定供应商提供的 PEM CA 文件。不能用跳过证书校验解决证书或域名不匹配。实现依据：[mysql2 SSL 文档](https://sidorares.github.io/node-mysql2/docs/documentation/ssl)。非生产环境的本地回环地址隔离测试库可关闭 TLS。连接 URL 不接受 query 参数；特殊密码字符须 URL 编码。

### 用户明确接受风险后的开发例外

用户于本阶段确认接受非加密远程连接。仅当 `NODE_ENV=development`、`DATABASE_SSL=false` 且 `DATABASE_ALLOW_INSECURE_REMOTE=true` 三项同时满足时，允许非加密远程 MySQL。该选项默认 false，生产环境即使设置该选项也拒绝非加密 MySQL。启用 TLS 时仍严格校验证书，不会连接失败后自动降级。PostgreSQL 配置和数据未改变。

仅用于验证的配置放在 `api/.env.mysql-check`，已加入 Git 忽略规则，API 不自动读取它。用户在本机填写 `MYSQL_PASSWORD` 后，从 `api` 目录运行 `pnpm db:check:mysql`。密码按原文填写，不用 URL 编码；含 `#` 或空格时需适当使用 dotenv 引号。不要在聊天或 Git 中提交密码。

此程序不加载 AppModule、原 `.env`、`.env.local` 或定时任务，仅查询版本、当前库、时区、TLS 状态及表清单，连接池上限在独立配置中设置为 1；不会改表或导入业务数据。非加密检查中 TLS 状态为空是预期结果，不代表安全连接。公网非加密连接不应用于生产或敏感数据。

MySQL 每次获取连接时设置服务器会话 UTC，驱动也按 UTC 读写日期。连接失败会阻止服务启动，不再假装数据库就绪。PostgreSQL 的既有 SSL 配置行为保留；如用于生产应另行审查。

## 已适配范围

- 登录、重复登录和资料更新；新 MySQL 记录的 UUID 由应用生成。
- 机位创建、编辑、删除、地图视野查询、城市聚合、发现/我的列表游标分页。
- GCJ-02 经纬度保存为 SRID 0 的 POINT，经度为 X、纬度为 Y；不是米制空间距离。
- 推荐时段、季节写入独立关联表，保留数组顺序；编辑可清空数组，重复值拒绝，不静默去重。
- 上传票据、照片及封面在事务中关联；MySQL 票据加锁，防止同图被并发发布至多个机位。创建和编辑都须至少保留一张照片。
- MySQL 孤儿票据清理在删除对象前重新加锁检查，避免清理已发布图片。
- 审核任务、回调幂等和超时处理；MySQL 图片审核可用时先保持 pending，预登记全量任务后提交；任意提交失败则隐藏待人工处理。未配置机审时仍沿用现有行为。
- 举报唯一性及阈值隐藏在 MySQL 事务内处理，支持运营恢复及结案。
- MySQL 浏览数自增不改变 `updated_at`，保持其表示内容/状态编辑时间。

`pnpm migrate` 和 `pnpm seed` 仍仅用于 PostgreSQL；遇到 MySQL URL 会主动拒绝，避免错用原脚本。手动建立的 MySQL baseline 不重复执行，不在此阶段伪造 `schema_migrations` 记录。

## 本地验证方式

在 `api` 目录运行 `pnpm typecheck`、`pnpm test`、`pnpm build`。

全链路测试仅允许回环地址且数据库名以 `_test` 结尾：

```powershell
# 仅填写独立、可丢弃的本地测试库，不能填现有业务库或远程库。
$env:MYSQL_TEST_DATABASE_URL='mysql://TEST_USER:TEST_PASSWORD@127.0.0.1:13306/photo_spot_backend_test'
pnpm test -- spots.e2e
Remove-Item Env:MYSQL_TEST_DATABASE_URL

$env:TEST_DATABASE_URL='postgres://TEST_USER:TEST_PASSWORD@127.0.0.1:15432/photo_spot_backend_test'
pnpm test -- spots.e2e
Remove-Item Env:TEST_DATABASE_URL
```

MySQL 测试要求目标完全空白，在该隔离库内执行 baseline；不会自动删表。重新运行须提供新的空测试库。测试使用临时上传目录，不写入原照片目录；微信机审使用模拟响应，不调用真实微信服务。

### 2026-09-30 验证记录

- `pnpm typecheck`、`pnpm build` 通过。
- 普通测试：114 项通过；未提供测试 URL 时跳过真实数据库用例。
- 官方 MySQL 8.4 镜像（实际 8.4.11）：16 项全链路测试通过。
- 独立 PostGIS 16 / 3.4 镜像：12 项 PostgreSQL 全链路回归通过，MySQL 专用用例不参与。
- 使用本次创建的临时容器及临时数据目录，没有挂载现有 PostgreSQL 数据卷，也没有访问远程 SQLPub。

现有 `start-local.cmd` / `tools/start-local.mjs` 仍是 PostgreSQL 本地启动流程，本阶段未修改用户已有启动脚本。MySQL 后续联调应从 `api` 目录启动，或在切换阶段单独适配根目录启动脚本；不要拿旧脚本判断 MySQL 是否已切换。

## 下一阶段及切换门槛

1. 补齐远程结构验收：CHECK 全部 ENFORCED=YES、空间索引存在，以及各表字段/外键定义符合 baseline。
2. 先用独立检查程序验证远程连接。用户已允许开发阶段暂缓 TLS；生产切换前仍须获取可信 CA 并验证远程域名及 TLS。Navicat 的连接设置不等于后端配置。
3. 对真正的数据源进行清点和预检，编写保留 ID、时间、图片 key 的迁移及逐表核对工具，在独立 MySQL 上演练。当前关联表布局并不支持直接执行 PostgreSQL 备份 SQL。
4. 制作最终备份、暂停写入、迁移并核对数据、验证图片访问，之后才批准切换实际连接。
5. 对手工 baseline 做完整结构校验后再登记校验和，自动迁移器需另行实现。

本阶段本地测试不代表远程权限、TLS、延迟和供应商兼容性已通过。不自动回退数据库：切换后如产生新数据，不能直接改回 PostgreSQL，否则会丢失切换后的写入。

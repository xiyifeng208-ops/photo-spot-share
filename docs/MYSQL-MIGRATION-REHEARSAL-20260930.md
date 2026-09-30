# PostgreSQL 到 MySQL 本地迁移演练报告

演练日期：2026-09-30。目标是验证已经确认的全部旧数据——三个开发用户、六个示例机位——能够保留 ID 和业务语义迁移到 MySQL。远程 SQLPub、源 PostgreSQL、原 `.env` 和既有备份均未修改。

## 环境和安全边界

- 源：本机 `localhost:5432/spot`，PostgreSQL 16.4 / PostGIS，使用可重复读只读事务取得一致快照。
- 目标：本轮创建的官方 MySQL 8.4 临时容器，绑定 `127.0.0.1:13308`，数据目录为 tmpfs，无宿主机数据卷。
- 成功目标库：`photo_spot_2_rehearsal`。工具硬性要求目标为回环地址且库名以 `_rehearsal` 结尾，不能用于远程数据库。
- 目标起始必须完全为空；工具在本地目标执行项目 baseline，然后只在一个业务事务中写入所有迁移数据。
- 未复制 PostgreSQL 的 `schema_migrations`；MySQL `schema_migrations` 保持 0 行，手工 baseline 的采用登记仍属于后续迁移器工作。

## 转换规则

- UUID、文本、枚举、数值及原始业务 ID 保留。
- PostGIS geography 不复制二进制，使用 `POINT(lng, lat)` 重建 SRID 0 的 MySQL POINT。
- `best_times` 和 `best_seasons` 按 PostgreSQL 数组下标分别拆到关联表，`sort_order` 从 0 开始，顺序保留。
- 机位先写入且封面暂为空，照片写入后再回填封面，适配循环外键；本批数据没有照片。
- 全部时间先转 UTC，再按目标 `DATETIME(3)` 截取到毫秒。共有 18 个时间字段的原微秒尾数非零并被舍弃：3 个用户的 created/updated 共 6 个，6 个机位的 created/updated 共 12 个。原始微秒值仍完整保存在已验证的 PostgreSQL 备份中。
- 旧 `spot_reports` 没有 `updated_at`；通用规则为以 `created_at` 初始化。本批数据该表为空。
- 六个无照片机位按用户确认全部保留，不伪造照片、不跳过机位。

## 结果

迁移事务提交前读取目标并与“按上述规则转换后的源快照”逐表计算完整内容 SHA-256；所有表的源/目标哈希一致：

| 表 | 源行数 | 目标行数 | 结果 |
| --- | ---: | ---: | --- |
| users | 3 | 3 | 完整内容一致 |
| spots | 6 | 6 | 完整内容一致 |
| spot_best_times | 12 | 12 | 顺序及内容一致 |
| spot_best_seasons | 18 | 18 | 顺序及内容一致 |
| photos | 0 | 0 | 一致 |
| upload_tickets | 0 | 0 | 一致 |
| content_check_tasks | 0 | 0 | 一致 |
| spot_reports | 0 | 0 | 一致 |

`ST_X(location)=lng`、`ST_Y(location)=lat` 且 SRID=0 的异常数为 0。

后端 MySQL 适配层对迁移结果执行只读业务读取：发现流读取 6 个机位；三个用户的“我的机位”各 2 个；地图高 zoom 空间查询读取 6 个点；低 zoom 城市聚合有结果；推荐时段 12、推荐季节 18；返回时间全部为 UTC ISO 字符串。没有调用详情接口，避免其浏览量自增副作用。

## 失败与保护验证

第一次演练暴露了机位 INSERT 少一个 SQL 占位符，MySQL 返回字段数量错误。该次目标业务事务已回滚；只读复核 users、spots、两个关联表均为 0。修正后使用全新的空库 `photo_spot_2_rehearsal` 重跑成功，没有复用失败库。

对成功库再次运行迁移工具时，工具返回 `REHEARSAL_TARGET_MUST_START_EMPTY` 并在任何业务写入前停止，证明不会把迁移重复叠加到非空目标。

## 复现方式

迁移工具：`tools/mysql/rehearse-migration.cjs`。先启动一个只监听本机的全新空 MySQL，并通过进程环境提供连接地址：

```powershell
$env:MYSQL_REHEARSAL_URL='mysql://TEST_USER:TEST_PASSWORD@127.0.0.1:TEST_PORT/photo_spot_rehearsal'
Set-Location E:\photo-spot-share\api
pnpm db:rehearse:mysql
pnpm db:verify:rehearsal
Remove-Item Env:MYSQL_REHEARSAL_URL
```

工具从 `api/.env`（若存在则再应用 `.env.local`）读取本地 PostgreSQL 源。密码不应写入报告、提交到 Git 或发到聊天中。每次重跑必须使用新的空 `_rehearsal` 数据库。

## 结论与下一门槛

本地迁移演练通过，转换规则和后端只读兼容性满足当前 3 用户、6 机位数据集。它不等于已完成远程迁移。下一阶段应把同一迁移核心封装为显式的远程导入流程，并增加：远程空库二次确认、执行前最终源备份与停写、执行后远程逐表哈希/业务读取、失败处置记录。由于用户选择非 TLS 公网连接，正式生产切换仍存在明示的传输安全风险。

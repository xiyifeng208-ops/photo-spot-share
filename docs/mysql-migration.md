# PostgreSQL/PostGIS → MySQL 迁移说明

## 在线迁移结果（2026-10-08 20:17，Asia/Shanghai）

- 已按用户授权删除在线旧九张表，以新结构重建六张业务表和独立迁移历史表。
- 已导入 4 个用户、6 个机位，其余四张业务表 0 条；原 UUID、全部字段、数组顺序、坐标及微秒时间逐字段核对通过。
- 原 PostgreSQL 业务数据保持不变，切换前重新导出确认与最终快照完全一致。
- 已备份并修改 `api/.env` 的 `DATABASE_URL`、`DATABASE_SSL`、`DATABASE_POOL_MAX` 三项；其他设置保持原值。连接池设为 3。
- 本地后端已启动并使用在线 MySQL，`/health` 返回 `ok` / `database: up`。
- 只读 API 验收通过：已有用户、全部 6 条机位分页、已有用户的 2 个机位、6 个地图点位、4 个城市聚合。没有为了验收新增在线账号或业务记录。
- 在线版本 `8.4.3-SQLPub-0.0.1`。TLS 握手测试失败，当前使用用户填写的非 TLS 配置；不能将此结果表述为已验证加密连接。
- 下一步由用户重新编译小程序验收实际页面及新增上传流程；后端端到端写入流程此前在独立本地 MySQL 已验证。

备份位置（均已被 git 忽略，包含私人数据和配置，勿分享或提交）：

| 内容 | 本地位置 |
| --- | --- |
| 刷新的 PostgreSQL 全量备份 | `backups/2026-10-08-mysql-preparation/2026-10-08T12-13-25-793Z/` |
| 最终导入快照 | `backups/2026-10-08-mysql-preparation/final-mysql-snapshot-20261008-2014.json` |
| 旧在线库 SQL/JSON/清单及恢复验证 | `backups/online-before-rebuild-2026-10-08T12-12-34-859Z/` |
| 原运行配置及切换记录 | `backups/runtime-cutover-2026-10-08T12-15-52-978Z/` |
| 在线后端只读验收记录 | `backups/mysql-runtime-verification-20261008.json` |

旧在线库 SQL 已在 `127.0.0.1:3307` 的独立 MySQL 完整恢复并逐字段核对。源 PostgreSQL 全量归档已完整解码检查，未执行源库恢复。

本轮新增操作工具：`tools/check-online-mysql.cjs` 用于脱敏只读探测，`backup-online-mysql.cjs` 用于旧库完整备份，`verify-online-backup.cjs` 将备份仅恢复到固定本地测试端点，`rebuild-online-mysql.cjs` 在校验备份和已知表集合后删除已授权旧表，`switch-to-online-mysql.cjs` 在源/目标复核后保留其他配置并切换三项数据库设置，`verify-mysql-runtime.cjs` 用于不新增数据的 API 验收。

## 适配阶段的状态与原则（切换前记录）

- MySQL 8.4 适配已实现；运行环境仍由原有 `api/.env` 决定，未自动切换。
- 在线旧库已由用户通过 Navicat 转储。本轮没有连接或操作在线数据库。
- 以 PostgreSQL 为数据源，保留原 UUID、全部业务字段、数组顺序、UTC 微秒时间和 GCJ-02 坐标数值。
- 图片属于文件存储，不存入数据库。当前源库 `photos` / `upload_tickets` 均为空，配置目录 `api/var/uploads` 不存在。若其他项目副本有图片，必须另行核对。
- 暂停源库写入后重新导出最终快照；试迁快照不是自动增量同步。

## 修改位置及原因

| 文件 | 修改及原因 |
| --- | --- |
| `api/package.json`、`api/pnpm-lock.yaml` | 增加 `mysql2`，增加 `migrate:mysql` / `transfer:mysql` 命令；保留已有依赖改动。项目执行命令统一使用 pnpm，已有 npm 锁文件未重写。 |
| `api/src/database/database.service.ts` | 按连接 URL 选择驱动，统一查询结果与事务接口；MySQL 连接使用 UTC、参数绑定及可验证的 TLS。保留 PostgreSQL 回退能力。 |
| `api/src/database/sql.ts` | 明确选择方言；将编号参数编译成 MySQL 参数，保留重复参数及顺序；字符串和注释不参与替换。分页保留微秒。 |
| `api/src/config/configuration.ts` | MySQL 未显式设置连接池时默认 3 个连接，适配在线实例 10 连接总额度。原 `.env` 中显式配置会优先，切换时需手动设为 3。 |
| `api/src/auth/auth.service.ts` | MySQL 使用后端 UUID、唯一键 upsert 和查询替代 PostgreSQL `RETURNING`，保持同一 openid 对应同一用户。 |
| `api/src/spots/spots.service.ts` | 改造空间筛选、JSON 数组、分页、创建编辑及照片关联；修复详情浏览量异步写入竞争。接口返回格式保持不变。 |
| `api/src/uploads/uploads.service.ts` | 改造上传票据 upsert、数组筛选、事务类型与过期时间查询，保留本地图片存储。 |
| `api/src/spots/moderation.service.ts` | 改造举报插入、重复举报错误及计数，保留唯一性约束。 |
| `api/src/spots/content-check-tasks.service.ts` | 为审核任务生成 UUID；通过行锁事务替代 `UPDATE ... RETURNING`，处理超时任务。 |
| `api/migrations/mysql/0001_init.sql` | 新建六张业务表，JSON 数组、空间索引、外键、枚举、范围约束及分页索引；不沿用旧在线关联表。 |
| `api/src/database/mysql-migration-runner.ts` | 独立 MySQL 迁移历史、校验和与迁移锁；拒绝自动覆盖未知旧表。MySQL DDL 隐式提交，失败后需检查部分建表结果。 |
| `api/src/database/migration-runner.ts`、`run-migrations.ts` | 原迁移命令按 URL 路由到对应迁移器。 |
| `api/src/database/run-mysql-migrations.ts` | 使用专用目标配置创建 MySQL 结构，避免提前改变运行环境。 |
| `api/src/database/run-seed.ts` | MySQL 环境拒绝执行 PostgreSQL 种子 SQL，避免误执行。 |
| `api/src/database/transfer-mysql.ts` | 一致性只读导出；目标空表检查；事务导入；延后恢复封面外键；提交前与导出逐字段核对；单独提供只读 verify。 |
| `api/.env.mysql.example`、`api/.env.example` | 提供不含真实凭据的迁移与运行配置说明。 |
| `.gitignore` | 忽略数据备份和 `.env.mysql.local`，防止备份及数据库密码进入版本控制。 |
| `tools/reset-online-mysql.sql` | 为用户已授权的旧在线九张表提供单独重建前清理脚本，未执行。 |
| `api/src/database/sql.spec.ts`、`mysql.integration.spec.ts`、`api/src/spots/spots.e2e.spec.ts` | 增加参数绑定、迁移失败回滚、完整核对、重复导入拒绝和双数据库业务验证。 |

## 数据结构决策

- 保留六张业务表：`users`、`spots`、`photos`、`upload_tickets`、`spot_reports`、`content_check_tasks`。
- `schema_migrations` 是 MySQL 独立历史，不复制 PostgreSQL 三条迁移记录或 PostGIS 扩展内部表。
- UUID 使用大小写敏感的 ASCII `CHAR(36)`；其他文本使用 `utf8mb4_bin`，避免 openid、对象 key 等唯一值被忽略大小写或音调。
- 原无长度限制的描述等文本使用 LONGTEXT。需索引的 `openid`、`city`、`object_key`、`trace_id` 使用 512 字符；导出发现超长值会停止，不截断数据。
- `best_times` / `best_seasons` 使用 JSON 数组，数据库校验数组元素合法性，保留顺序与空数组。
- `DATETIME(6)` 保存 UTC 微秒。运行连接与导入连接使用 UTC；JSON 接口仍返回原来的日期格式，分页比较单独保留六位精度。
- `location` 使用 `POINT SRID 0`，X=经度，Y=纬度，保持 GCJ-02 数值。矩形查询使用 MBRIntersects 加经纬度范围校验，距离保持原 JS Haversine 实现。并不将 GCJ-02 转换为 WGS-84。
- PostgreSQL 的部分索引改为 MySQL 组合索引；封面照片循环依赖在数据导入时先置空、最后恢复，导入过程不关闭外键。

## 已完成验证（2026-10-08）

- TypeScript 类型检查和 Nest 构建通过。
- 独立本地 MySQL 8.4.11 容器通过业务端到端测试：登录、用户资料、上传、发布、地图点位、城市聚合、列表、编辑数组/坐标/照片、分页、浏览量、审核超时、举报及删除权限。在线实例是 8.4.3，实际在线权限、TLS 及兼容性尚待验证。
- 对原 PostgreSQL 只读导出，在独立 MySQL 测试库试迁，逐字段核对通过；验证外键失败时全部回滚、重复导入拒绝和迁移重复执行。
- 在独立 PostgreSQL 测试库跑同一套业务端到端测试，确认原驱动路径可用。
- 最终综合测试 12 套、130 项全部通过；另一次最终 MySQL 业务运行 125 项通过，5 项独立迁移用例未启用。两次联合覆盖 PostgreSQL、MySQL 和同一毫秒内的微秒分页边界。
- 测试容器：`photo-spot-mysql-validation-20261008`，仅本机 `127.0.0.1:3307`，无密码测试账号仅用于本地验证，不用于在线环境。
- 验证结束后已停止该测试容器，保留测试结果；需要复查时可显式启动。
- 测试库为独立 scratch 库，未修改源业务库 `spot`。迁移测试必须使用空的专用测试库，不能对业务库执行。

## 实际切换步骤

在 PowerShell 中进入 `D:\photo-spot-share\api`。

1. 将 `.env.mysql.example` 复制为 `.env.mysql.local`，仅在本机填写源库和目标库连接；URL 密码中的特殊字符需百分号编码。先向服务商确认 TLS 支持再设置 `TARGET_DATABASE_SSL`，启用时验证证书。
2. 确认在线备份可用、团队没有依赖旧在线表；在 Navicat 的 `photo_spot_share` 上执行 `tools/reset-online-mysql.sql`。这是有意删除旧表的独立步骤，不会由后端启动或迁移脚本自动触发。
3. 创建新结构：

   ```powershell
   corepack pnpm migrate:mysql
   ```

   若 DDL 中途失败，停止导入并检查目标表；只有确认仍是本次重建的目标库后，才清理部分结构重新运行。DDL 不能靠事务回滚。

4. 暂停小程序操作及会写数据库的本地后端/定时任务，确保源库不再变化；刷新 PostgreSQL 和图片备份。导出新的最终快照，使用一个不存在的文件名：

   ```powershell
   corepack pnpm transfer:mysql export ..\backups\final-mysql-snapshot.json
   ```

5. 导入并单独复核：

   ```powershell
   corepack pnpm transfer:mysql import ..\backups\final-mysql-snapshot.json
   corepack pnpm transfer:mysql verify ..\backups\final-mysql-snapshot.json
   ```

   仅空的六张业务表可以导入。全部字段核对通过才提交；不覆盖已有记录。

6. 在 `api/.env` 中切换 `DATABASE_URL` 为目标 MySQL URL，设 `DATABASE_POOL_MAX=3`，将 `DATABASE_SSL` 与已验证的 TLS 配置一致；保留 `JWT_SECRET`、鉴权、图片目录及其他业务配置。重启后端，检查 `/health` 和小程序完整流程。
7. 切换后验收新增机位、图片、编辑及删除权限；保留原 PostgreSQL 和两侧备份。

## 回退边界

切换前或 MySQL 尚未产生新写入时，可恢复原 PostgreSQL URL 并重启。MySQL 有新写入后，直接切回旧 PostgreSQL 会遗漏这些新增数据：应先停止写入、备份 MySQL，再制定反向同步方案。

## 适配阶段未修改的现有内容（切换前记录）

未替换 `api/.env`、未修改小程序配置、未写入在线数据库。工作区原本存在的 package/lock 文件和小程序地址改动已保留，不能把所有 git diff 都认作本轮新增。

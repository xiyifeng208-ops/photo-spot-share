# 远程 MySQL 正式数据迁移报告

迁移时间：2026-09-30 17:59（北京时间）。用户明确授权正式写入远程数据库，并要求暂不切换 `.env`。

## 执行前门槛

- 确认监听 3000 端口的进程为本项目 `api/dist/main`，随后停止；迁移期间本地 API 不再写入 PostgreSQL。
- 制作最终 PostgreSQL 备份 `work/backups/docker-spot-20260930-Q8Z70p/spot.dump`，SHA-256 为 `648a2f1d5aa0e413d148f23d7bb9f766f46708e26373fb2aafa49ae22a189d71`。
- 最终备份在全新独立库恢复成功，所有业务表的完整内容哈希一致。
- 正式迁移工具再次确认当前源库与最终备份的逐表行数及完整内容哈希一致，排除备份后新增写入。
- 远程目标固定为 `mysql6.sqlpub.com:3311/photo_spot_share`。写入前再次确认九张预期表且所有表为空；9 个主键、8 个唯一约束、11 个外键、16 个 CHECK（全部启用）、POINT SRID 0 和空间索引均符合 baseline。
- 迁移没有执行 DDL、DROP、TRUNCATE、关闭外键或复制 PostgreSQL 迁移历史。

## 正式导入结果

所有业务数据在一个 MySQL 事务中写入。提交前，程序读取目标并与按既定规则转换后的同一 PostgreSQL 源快照逐表计算完整内容 SHA-256。结果如下：

| 表 | 源 → 目标 | SHA-256 | 结果 |
| --- | ---: | --- | --- |
| users | 3 → 3 | `d274ad83d2e82bcec2ceff03b2a9bc7e8119326f9e4cb43b8a3bfdf8b08c3d68` | 一致 |
| spots | 6 → 6 | `24aba1bdcd4969ccc86da0f2425cf5797b3d6902dc8cfa2e42209f4707b744bf` | 一致 |
| spot_best_times | 12 → 12 | `dc8784f65eab01509ee3188567194eac85363ec919f2176401a6ced85cb4c9cb` | 一致 |
| spot_best_seasons | 18 → 18 | `8b788edf76ba36bc2feeee4da009aec3aafcfe7a86b4153c6e61974bd0cfee0a` | 一致 |
| photos | 0 → 0 | 空数组哈希一致 | 一致 |
| upload_tickets | 0 → 0 | 空数组哈希一致 | 一致 |
| content_check_tasks | 0 → 0 | 空数组哈希一致 | 一致 |
| spot_reports | 0 → 0 | 空数组哈希一致 | 一致 |

- 六个无照片历史机位全部保留。
- 推荐时段和季节按原数组顺序拆分。
- 18 个非零微秒尾数的时间字段按设计转换为 UTC 毫秒；原始精度在最终 PostgreSQL 备份中保留。
- MySQL POINT 由 lng/lat 重建；坐标或 SRID 不一致数为 0。
- 目标 `schema_migrations` 仍为 0 行，未伪造手工 baseline 采用记录。

## 提交后独立只读验证

使用正式后端 MySQL 适配层重新建立连接并执行只读业务查询：

- 发现流：6 个机位。
- 地图空间查询：6 个点。
- 低 zoom 城市聚合：4 组。
- 三个用户的“我的机位”：各 2 个。
- 推荐时段 12、推荐季节 18。
- 返回的 createdAt 全部为 UTC ISO 时间。

没有调用会自增浏览量的详情接口。随后再次运行正式迁移工具，程序在预检查阶段返回 `REMOTE_TARGET_NOT_EMPTY`，未进入写入事务，验证了防重复导入保护。

## 当前状态与下一步

- 数据已经存在远程 MySQL；不要再执行 baseline 或正式迁移工具。
- `api/.env` 尚未修改，本地后端仍处于停止状态，避免 PostgreSQL 和 MySQL 两边继续产生分叉写入。
- 本地 PostgreSQL、Docker 数据卷和新旧备份均保留，未删除。
- 远程连接按用户明确选择未使用 TLS，公网传输存在窃听或篡改风险；生产模式仍会拒绝非 TLS 连接。
- 下一步需要单独授权切换 `.env`，然后启动后端并进行登录、地图、列表、详情及写入冒烟测试。切换后若产生新写入，不能直接改回 PostgreSQL，否则会丢失这些新数据。

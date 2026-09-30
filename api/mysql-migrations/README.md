# MySQL 建表阶段

目标为 SQLPub MySQL 8.4。此目录独立于现有 PostgreSQL `migrations/`，当前 `pnpm migrate` 仍执行 PostgreSQL 迁移，不能用它运行这里的脚本。

## Navicat 操作顺序

1. 连接远程 MySQL，在客户端明确选择本项目数据库 `photo_spot_share`。
2. 打开并执行 `../../tools/mysql/preflight.sql`，确认库名正确、表和视图清单为空。若存在任何对象，先停止并检查，不执行 baseline。
3. 使用 Navicat 的 SQL 文件执行功能运行 `0001_mysql_baseline.sql`，关闭“遇到错误继续执行”。文件采用 UTF-8 编码。不要选择其他业务数据库。
4. 成功后执行 `../../tools/mysql/verify-schema.sql`，核对 9 张表、11 个外键、16 个启用的 CHECK、8 个唯一约束，以及空间列和索引。
5. 所有表应为空，包括 `schema_migrations`。本阶段不导入种子数据、不迁移旧数据、不修改 API 的 PostgreSQL 连接。

## 失败与重复执行

MySQL DDL 隐式提交；多条建表语句不构成可整体回滚的事务。参考：[MySQL Atomic DDL](https://dev.mysql.com/doc/refman/8.4/en/atomic-ddl.html)。

脚本故意不使用 `IF NOT EXISTS`，避免把已有但不兼容的表当作成功。不包含 DROP、TRUNCATE、关闭外键检查或业务数据写入。若中途失败，保存第一条报错及已执行语句，停止执行；先检查部分结构，再制定修复方案，不直接重跑或删表。

本次是手工建立 baseline，不是完整自动迁移器。后续迁移器需要先验证整套结构，再将此文件的 SHA-256 登记到 `schema_migrations`。在校验前不得补造已成功执行的迁移记录；正式迁移器需处理隐式提交、失败续作、并发锁和校验和。

## 设计边界

- 遵循 `docs/MYSQL-DATABASE-DESIGN.md` 的字段设计，保留 UUID 文本和现有接口语义。
- `SET SESSION time_zone='+00:00'` 只影响本次连接；未来每个应用连接都要设置 UTC。
- 两个多值字段拆成关联表。重复数组元素、过长字段、重复图片 key 等旧数据需在迁移前预检，不可静默去重或截断。
- GCJ-02 经纬度存入 `POINT SRID 0`，只用于矩形视野查询；不把 SRID 0 平面距离当米。
- 跨表照片归属、每个机位至少一张照片由后端事务保证。
- 沿用设计中的 `updated_at ON UPDATE`，浏览计数也会更新该字段；后端改造时须明确它是否表示任意更新还是内容编辑时间。
- 原生 MySQL 的验证不等于 SQLPub 已验证；SQLPub 的权限、代理和功能限制需通过远程执行结果确认。

## 本地验证记录（2026-09-30）

使用官方 `mysql:8.4` 镜像（实际版本 8.4.11）的隔离临时容器执行成功：9 张表、9 个主键、8 个唯一约束、11 个外键和 16 个启用的 CHECK；location 为非空 POINT、SRID=0，并存在空间索引。另验证空间包围盒命中、删除封面照片后外键置空、删除机位后照片及多值关联级联删除、事务回滚不留测试数据、非法审核状态触发 CHECK 错误 3819。测试容器随后关闭并移除。

远程 SQLPub 为 8.4.3-SQLPub-0.0.1。用户随后在 Navicat 执行成功并提供截图：约束数量、POINT 非空/SRID=0、九表为空及坐标函数结果符合预期；CHECK 是否全部启用及空间索引明细仍需补齐验收。后端适配说明见 `docs/MYSQL-BACKEND-ADAPTATION.md`（项目根目录）。

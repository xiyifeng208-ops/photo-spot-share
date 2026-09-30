# 后端切换远程 MySQL 验收记录（2026-09-30）

## 结论

- 本地后端已从本机 PostgreSQL 切换至远程 MySQL。
- 后端当前监听 `http://127.0.0.1:3000`，进程 PID 为 `36696`。
- 健康检查返回 `status=ok`、`database=up`。
- 原 PostgreSQL 数据库和配置备份均保留，没有删除或覆盖 PostgreSQL 数据。
- 远程 MySQL 中原有的 3 个用户、6 个机位及其关联数据保持不变。

## 当前数据库配置摘要

- 类型：MySQL
- 地址：`mysql6.sqlpub.com:3311`
- 数据库：`photo_spot_share`
- 连接池上限：1
- TLS：关闭
- 非加密远程连接：仅在当前 `development` 环境显式允许

数据库密码未写入本报告。实际私密配置仍只保存在被 Git 忽略的本机环境文件中。

## PostgreSQL 配置保留

切换前的完整 `.env` 已备份至：

`E:\photo-spot-share\work\backups\config-before-mysql-2026-09-30T10-16-57-474Z\.env`

备份 SHA-256：

`261e0b4a6c5cfa56d27b6a21cf9e5aaaf81b7dce07f136d2a776de1fc9204f2b`

此前生成并验证过的 PostgreSQL 数据备份仍位于：

`E:\photo-spot-share\work\backups\docker-spot-20260930-Q8Z70p\spot.dump`

## 验收项目

以下项目均已通过：

1. 后端使用新 `.env` 启动，远程数据库连接成功。
2. 健康检查正常。
3. 发现列表返回 6 个机位。
4. 地图接口返回 6 个机位，低缩放级别返回 4 个聚合组。
5. 3 个原用户各自仍拥有 2 个机位。
6. 推荐时段关联 12 条，推荐季节关联 18 条。
7. 时间字段均按 UTC 输出。
8. 临时开发用户登录成功。
9. 本地图片上传、远程上传票据写入成功。
10. 临时机位创建、详情读取、地图读取、发现列表读取和删除均成功。
11. 验收产生的临时用户、机位、照片、上传票据及本地测试文件均已清理。

## 验收后数据量

| 表 | 行数 |
|---|---:|
| users | 3 |
| spots | 6 |
| spot_best_times | 12 |
| spot_best_seasons | 18 |
| photos | 0 |
| upload_tickets | 0 |
| content_check_tasks | 0 |
| spot_reports | 0 |

## 注意事项

- 当前远程连接未启用 TLS，数据库凭据和业务数据在网络传输过程中不受加密保护。该设置只适合当前已明确接受风险的开发阶段，不应直接用于生产环境或真实敏感数据。
- 从本次切换后的正式业务写入开始，PostgreSQL 与 MySQL 不会自动双向同步。若以后回退到 PostgreSQL，需要先制定增量数据回迁方案，不能只把 `.env` 改回去。
- 当前图片存储仍为本地磁盘；后端换电脑或正式部署前，应单独迁移图片存储或切换到对象存储。

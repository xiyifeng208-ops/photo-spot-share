# 远程 MySQL 数据库设计文档

> 项目：旅游拍照机位打卡分享  
> 文档状态：设计稿，尚未实施  
> 目标数据库：MySQL 8.0.30+ / InnoDB  
> 编写日期：2026-09-21  
> 本文只定义目标结构和迁移边界，不代表迁移已经执行。

## 1. 文档目标

当前项目使用本地或容器化 PostgreSQL + PostGIS，后端通过 `pg` 驱动执行手写 SQL。
本次数据库重构的目标是：

1. 将业务数据库迁移到远程托管 MySQL。
2. 保持现有微信小程序接口的字段含义和主要业务行为不变。
3. 去除 PostgreSQL/PostGIS 专用数据类型与 SQL 语法。
4. 修补现有结构中缺少的唯一约束、状态约束和关键索引。
5. 为后续的数据迁移脚本、后端数据库适配和上线切换提供唯一设计基线。

本阶段不包含：

- 修改后端数据库驱动。
- 编写或执行 MySQL 迁移脚本。
- 连接、创建或删除任何远程数据库。
- 迁移现有业务数据。
- 修改小程序接口。

## 2. 当前结构摘要

当前 PostgreSQL 数据库包含 6 张业务表和 1 张迁移记录表：

| 当前表 | 用途 |
| --- | --- |
| `users` | 微信用户及资料 |
| `spots` | 拍照机位主数据 |
| `photos` | 机位样张 |
| `upload_tickets` | 上传凭证及孤儿文件追踪 |
| `content_check_tasks` | 微信图片机审任务 |
| `spot_reports` | 用户举报 |
| `schema_migrations` | 已执行的数据库迁移 |

PostgreSQL 特有能力包括：UUID 默认生成、`timestamptz`、自定义枚举、枚举数组、PostGIS
`geography(Point, 4326)`、GIST 索引、部分索引、`RETURNING`、`ON CONFLICT` 和 `$1` 参数占位符。

目标 MySQL 结构保留原有 6 张业务表，新增 2 张多值关联表，并保留 1 张迁移记录表。

## 3. 设计结论

### 3.1 基础约定

| 项目 | 决策 |
| --- | --- |
| 数据库引擎 | MySQL 8.0.30+，InnoDB |
| 默认字符集 | `utf8mb4` |
| 默认排序规则 | `utf8mb4_0900_ai_ci` |
| 标识符字段 | `CHAR(36)` UUID 字符串，ASCII 二进制排序 |
| 时间字段 | `DATETIME(3)`，应用和数据库连接统一使用 UTC |
| 坐标系 | GCJ-02，经纬度含义与当前小程序保持一致 |
| 空间字段 | `POINT SRID 0`，只用于平面包围盒查询，不声明为 EPSG:4326 |
| 多值枚举 | 拆成关联表，不保存为 JSON 或逗号字符串 |
| 状态字段 | `VARCHAR` + `CHECK`，避免 MySQL `ENUM` 的演进限制 |
| 软删除 | `spots.status = 'deleted'`，保持现有接口行为 |
| 表名/字段名 | 延续现有 snake_case，降低应用改造成本 |

### 3.2 为什么 UUID 先使用 `CHAR(36)`

目标库继续保存现有 UUID 文本，不在本次迁移中改成 `BINARY(16)`：

- 可以无损搬迁当前主键和外键。
- API、JWT、对象存储路径和测试数据不需要更换 ID 表达。
- 数据校验和人工排障更直接。
- 当前预期数据量不足以抵消二进制 UUID 带来的迁移复杂度。

若将来数据量达到需要压缩主键索引的程度，可独立设计 `BINARY(16)` 升级，不与本次数据库换型绑定。

### 3.3 为什么多值枚举拆表

当前 `best_times` 和 `best_seasons` 是 PostgreSQL 枚举数组。MySQL 虽然支持 JSON，
但 JSON 数组的外键约束、枚举合法性、常规索引和统计查询都更复杂。因此改为：

- `spot_best_times`
- `spot_best_seasons`

这样可以直接按时段或季节筛选，并由数据库约束合法取值。

### 3.4 为什么空间字段使用 SRID 0

项目保存的是 GCJ-02 坐标。GCJ-02 不是 EPSG:4326，不能为了使用空间索引而把它标记成
WGS-84。目标结构采用：

- `lat`、`lng`：业务和接口使用的真实 GCJ-02 数值。
- `location POINT SRID 0`：使用 `(lng, lat)` 顺序，仅用于地图包围盒相交查询。
- 用户距离继续由应用层基于 GCJ-02 经纬度计算，不使用 SRID 0 做真实地球距离计算。

SRID 0 在 MySQL 中表示无单位的笛卡尔平面，符合当前“只做视野矩形查询”的用途。空间列必须
`NOT NULL` 且限制 SRID，才能可靠使用 `SPATIAL INDEX`。

## 4. 目标数据模型

```text
users
 ├─< spots
 │    ├─< spot_best_times
 │    ├─< spot_best_seasons
 │    ├─< photos
 │    ├─< upload_tickets
 │    ├─< content_check_tasks
 │    └─< spot_reports
 │
 ├─< photos
 ├─< upload_tickets
 └─< spot_reports (reporter_id)

spots.cover_photo_id ──> photos.id
```

目标库共 8 张业务表：

1. `users`
2. `spots`
3. `spot_best_times`
4. `spot_best_seasons`
5. `photos`
6. `upload_tickets`
7. `content_check_tasks`
8. `spot_reports`

另有系统表 `schema_migrations`。

## 5. 表结构设计

### 5.1 `users` 用户表

| 字段 | MySQL 类型 | 空值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `CHAR(36)` ASCII | 否 | 无 | UUID 主键，由应用生成 |
| `openid` | `VARCHAR(128)` ASCII | 否 | 无 | 微信 OpenID，全局唯一 |
| `nickname` | `VARCHAR(24)` | 是 | `NULL` | 用户昵称 |
| `avatar_url` | `VARCHAR(512)` | 是 | `NULL` | 头像最终访问地址 |
| `created_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 创建时间 |
| `updated_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 自动更新时间 |

约束和索引：

- 主键：`PRIMARY KEY (id)`
- 唯一索引：`uk_users_openid (openid)`

### 5.2 `spots` 机位主表

| 字段 | MySQL 类型 | 空值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `CHAR(36)` ASCII | 否 | 无 | UUID 主键 |
| `user_id` | `CHAR(36)` ASCII | 否 | 无 | 作者 ID |
| `title` | `VARCHAR(40)` | 否 | 无 | 机位标题 |
| `description` | `VARCHAR(1000)` | 否 | `''` | 拍摄说明 |
| `location` | `POINT SRID 0` | 否 | 无 | `(lng, lat)` 空间点，仅供包围盒查询 |
| `lat` | `DOUBLE` | 否 | 无 | GCJ-02 纬度 |
| `lng` | `DOUBLE` | 否 | 无 | GCJ-02 经度 |
| `province` | `VARCHAR(64)` | 是 | `NULL` | 省级行政区 |
| `city` | `VARCHAR(64)` | 是 | `NULL` | 城市 |
| `district` | `VARCHAR(64)` | 是 | `NULL` | 区县 |
| `address` | `VARCHAR(256)` | 是 | `NULL` | 详细地址 |
| `heading` | `VARCHAR(2)` ASCII | 是 | `NULL` | 拍摄方向 |
| `focal_length` | `VARCHAR(16)` ASCII | 是 | `NULL` | 推荐焦段 |
| `difficulty` | `TINYINT UNSIGNED` | 否 | `1` | 到达难度 1～3 |
| `access_note` | `VARCHAR(300)` | 是 | `NULL` | 到达提示 |
| `cover_photo_id` | `CHAR(36)` ASCII | 是 | `NULL` | 封面照片 ID |
| `status` | `VARCHAR(16)` ASCII | 否 | `'active'` | 机位状态 |
| `view_count` | `BIGINT UNSIGNED` | 否 | `0` | 浏览次数 |
| `created_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 创建时间 |
| `updated_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 自动更新时间 |

状态取值：

- `pending`：等待图片机审，只对作者可见。
- `active`：公开展示。
- `hidden`：审核、举报或运营处置后隐藏。
- `deleted`：用户软删除。

方向取值：`N / NE / E / SE / S / SW / W / NW`。

焦段取值：`ultrawide / standard / tele / macro / drone`。

约束：

- `user_id -> users.id ON DELETE CASCADE`
- `cover_photo_id -> photos.id ON DELETE SET NULL`，在 `photos` 建表后补充。
- `lat BETWEEN -90 AND 90`
- `lng BETWEEN -180 AND 180`
- `difficulty BETWEEN 1 AND 3`
- `heading`、`focal_length`、`status` 使用 `CHECK` 限制合法值。

索引：

| 索引 | 字段 | 服务的查询 |
| --- | --- | --- |
| `spx_spots_location` | `SPATIAL(location)` | 地图视野查询 |
| `idx_spots_feed` | `(status, created_at DESC, id DESC)` | 全国发现流 |
| `idx_spots_city_feed` | `(status, city, created_at DESC, id DESC)` | 城市发现流 |
| `idx_spots_user_created` | `(user_id, created_at DESC, id DESC)` | “我的机位”游标分页 |

`location` 与 `lat/lng` 必须在同一次插入或更新中写入。数据库迁移完成后应增加一致性巡检，验证：

```text
ST_X(location) = lng
ST_Y(location) = lat
```

### 5.3 `spot_best_times` 推荐时段关联表

| 字段 | MySQL 类型 | 空值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `spot_id` | `CHAR(36)` ASCII | 否 | 无 | 机位 ID |
| `best_time` | `VARCHAR(16)` ASCII | 否 | 无 | 推荐时段 |
| `sort_order` | `TINYINT UNSIGNED` | 否 | `0` | 返回数组时的顺序 |

时段取值：

`sunrise / morning / noon / afternoon / sunset / blue_hour / night`

约束和索引：

- 主键：`PRIMARY KEY (spot_id, best_time)`
- 唯一约束：`UNIQUE (spot_id, sort_order)`
- 外键：`spot_id -> spots.id ON DELETE CASCADE`
- 反向筛选索引：`idx_spot_best_times_value (best_time, spot_id)`

### 5.4 `spot_best_seasons` 推荐季节关联表

| 字段 | MySQL 类型 | 空值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `spot_id` | `CHAR(36)` ASCII | 否 | 无 | 机位 ID |
| `season` | `VARCHAR(8)` ASCII | 否 | 无 | 推荐季节 |
| `sort_order` | `TINYINT UNSIGNED` | 否 | `0` | 返回数组时的顺序 |

季节取值：`spring / summer / autumn / winter`。

约束和索引：

- 主键：`PRIMARY KEY (spot_id, season)`
- 唯一约束：`UNIQUE (spot_id, sort_order)`
- 外键：`spot_id -> spots.id ON DELETE CASCADE`
- 反向筛选索引：`idx_spot_best_seasons_value (season, spot_id)`

### 5.5 `photos` 机位照片表

| 字段 | MySQL 类型 | 空值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `CHAR(36)` ASCII | 否 | 无 | UUID 主键 |
| `spot_id` | `CHAR(36)` ASCII | 否 | 无 | 所属机位 |
| `user_id` | `CHAR(36)` ASCII | 否 | 无 | 上传者 |
| `object_key` | `VARCHAR(512)` ASCII | 否 | 无 | 对象存储唯一键 |
| `mime` | `VARCHAR(64)` ASCII | 是 | `NULL` | MIME 类型 |
| `size_bytes` | `BIGINT UNSIGNED` | 是 | `NULL` | 文件字节数 |
| `width` | `INT UNSIGNED` | 是 | `NULL` | 图片宽度 |
| `height` | `INT UNSIGNED` | 是 | `NULL` | 图片高度 |
| `sort_order` | `TINYINT UNSIGNED` | 否 | `0` | 机位内显示顺序 |
| `created_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 创建时间 |

约束和索引：

- `spot_id -> spots.id ON DELETE CASCADE`
- `user_id -> users.id ON DELETE CASCADE`
- `UNIQUE (object_key)`，防止同一对象重复形成照片记录。
- `UNIQUE (spot_id, sort_order)`，防止同一机位出现重复顺序。
- 图片尺寸和文件大小如果有值，必须大于 0。

业务约束：

- 每个机位至少 1 张、最多 9 张照片。
- `photos.user_id` 应与所属 `spots.user_id` 相同。
- `spots.cover_photo_id` 必须指向该机位自己的照片。

后两项属于跨表约束，不使用复杂触发器；由事务代码保证，并通过一致性巡检检测。

### 5.6 `upload_tickets` 上传票据表

| 字段 | MySQL 类型 | 空值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `CHAR(36)` ASCII | 否 | 无 | UUID 主键 |
| `user_id` | `CHAR(36)` ASCII | 否 | 无 | 票据所有者 |
| `object_key` | `VARCHAR(512)` ASCII | 否 | 无 | 对象存储唯一键 |
| `mime` | `VARCHAR(64)` ASCII | 是 | `NULL` | MIME 类型 |
| `size_bytes` | `BIGINT UNSIGNED` | 是 | `NULL` | 文件字节数 |
| `width` | `INT UNSIGNED` | 是 | `NULL` | 图片宽度 |
| `height` | `INT UNSIGNED` | 是 | `NULL` | 图片高度 |
| `spot_id` | `CHAR(36)` ASCII | 是 | `NULL` | 使用该图片的机位 |
| `created_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 票据签发时间 |
| `used_at` | `DATETIME(3)` | 是 | `NULL` | 绑定机位时间 |

约束和索引：

- `user_id -> users.id ON DELETE CASCADE`
- `spot_id -> spots.id ON DELETE SET NULL`
- `UNIQUE (object_key)`
- `idx_upload_tickets_orphan (spot_id, created_at)`：替代 PostgreSQL 的部分索引。
- `idx_upload_tickets_user_created (user_id, created_at DESC)`

未使用票据定义为 `spot_id IS NULL`。超过 24 小时后，任务先删除对象存储文件，再删除票据记录。
清理过程必须可重复执行；文件不存在应视为可继续删除票据，而不是永久失败。

### 5.7 `content_check_tasks` 图片机审任务表

| 字段 | MySQL 类型 | 空值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `CHAR(36)` ASCII | 否 | 无 | UUID 主键 |
| `spot_id` | `CHAR(36)` ASCII | 否 | 无 | 所属机位 |
| `trace_id` | `VARCHAR(128)` ASCII | 是 | `NULL` | 微信机审追踪 ID |
| `status` | `VARCHAR(16)` ASCII | 否 | `'pending'` | 任务状态 |
| `attempts` | `INT UNSIGNED` | 否 | `0` | 提交或查询尝试次数 |
| `detail` | `VARCHAR(500)` | 是 | `NULL` | 结果标签或失败说明 |
| `created_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 创建时间 |
| `updated_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 自动更新时间 |

状态取值：`pending / pass / risky / failed`。

约束和索引：

- `spot_id -> spots.id ON DELETE CASCADE`
- `UNIQUE (trace_id)`；MySQL 允许唯一索引中存在多个 `NULL`。
- `idx_content_tasks_poll (status, created_at)`：超时任务扫描。
- `idx_content_tasks_spot (spot_id, status)`：按机位汇总审核结果。

超过 10 分钟仍为 `pending` 的任务转为 `failed`；只要任意图片为 `risky` 或 `failed`，机位置为
`hidden`；全部为 `pass` 时才将 `pending` 机位转为 `active`。

### 5.8 `spot_reports` 举报表

| 字段 | MySQL 类型 | 空值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | `CHAR(36)` ASCII | 否 | 无 | UUID 主键 |
| `spot_id` | `CHAR(36)` ASCII | 否 | 无 | 被举报机位 |
| `reporter_id` | `CHAR(36)` ASCII | 否 | 无 | 举报用户 |
| `reason` | `VARCHAR(64)` | 否 | 无 | 举报原因 |
| `detail` | `VARCHAR(200)` | 是 | `NULL` | 补充说明 |
| `status` | `VARCHAR(16)` ASCII | 否 | `'open'` | 处理状态 |
| `created_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 创建时间 |
| `updated_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 自动更新时间 |

状态取值：`open / resolved / rejected`。

约束和索引：

- `spot_id -> spots.id ON DELETE CASCADE`
- `reporter_id -> users.id ON DELETE CASCADE`
- `UNIQUE (spot_id, reporter_id)`：同一用户只能举报一次。
- `idx_spot_reports_status_created (status, created_at DESC)`
- `idx_spot_reports_spot_status (spot_id, status)`

举报原因当前允许：

- 违法违规内容
- 侵犯他人权益
- 虚假或误导信息
- 地点敏感或危险
- 其他

原因列表仍由应用层校验，数据库不设置固定 `CHECK`，以便运营以后增加原因而不改表。

### 5.9 `schema_migrations` 迁移记录表

| 字段 | MySQL 类型 | 空值 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `name` | `VARCHAR(255)` ASCII | 否 | 无 | 迁移文件名，主键 |
| `checksum` | `CHAR(64)` ASCII | 否 | 无 | SQL 文件 SHA-256 |
| `execution_ms` | `INT UNSIGNED` | 是 | `NULL` | 执行耗时 |
| `applied_at` | `DATETIME(3)` | 否 | 当前 UTC 时间 | 执行时间 |

MySQL 迁移历史必须从新的 MySQL baseline 开始，不能直接复制 PostgreSQL 的
`schema_migrations` 记录，因为旧记录对应的是无法在 MySQL 执行的 SQL。

## 6. 删除与保留策略

| 主记录操作 | 关联数据行为 |
| --- | --- |
| 物理删除用户 | 级联删除其机位、照片、上传票据和举报 |
| 物理删除机位 | 级联删除时段、季节、照片、机审任务和举报 |
| 物理删除机位 | 相关上传票据 `spot_id` 置空 |
| 物理删除照片 | 引用它的 `cover_photo_id` 置空 |
| 用户删除机位 | 只把状态改成 `deleted`，不物理删除 |

生产环境原则上不直接物理删除用户或机位。若未来增加注销功能，需要单独定义对象存储清理、
审计保留和个人信息删除策略。

## 7. 状态流转

### 7.1 机位状态

```text
创建
 ├─ 文本不通过 ─────────────> hidden
 ├─ 无图片机审通道 ─────────> active
 └─ 等待图片机审 ───────────> pending
                                ├─ 全部通过 ─> active
                                └─ 风险/超时 ─> hidden

active ── 举报阈值/运营下线 ─> hidden
active/hidden/pending ── 用户删除 ─> deleted
hidden/deleted ── 运营恢复 ────────> active
```

图片机审回调只能更新当前仍为 `pending` 的机位，不能把已删除机位重新变成 `active`。

### 7.2 机审任务状态

```text
pending ── 回调通过 ─> pass
pending ── 风险命中 ─> risky
pending ── 超时/失败 ─> failed
```

终态回调必须幂等，重复回调不得再次改变结果。

### 7.3 举报状态

```text
open ── 确认违规 ─> resolved
open ── 驳回举报 ─> rejected
```

## 8. 核心事务边界

### 8.1 创建机位

数据库事务内：

1. 校验所有上传票据属于当前用户且未被其他机位使用。
2. 创建 `spots`。
3. 批量创建 `spot_best_times` 和 `spot_best_seasons`。
4. 创建 `photos`。
5. 回填 `upload_tickets.spot_id` 和 `used_at`。
6. 设置 `spots.cover_photo_id`。
7. 提交事务。

外部微信内容安全调用不能包含在数据库长事务中。重构后的应用应在入库前确定初始状态：需要图片机审时
直接以 `pending` 创建，避免当前实现中“先短暂公开为 active，再改 pending”的窗口。

### 8.2 编辑机位

编辑基础信息、时段、季节和照片必须在一个事务内完成。照片采用整体替换语义：

1. 校验新旧 `object_key`。
2. 删除旧照片关联。
3. 解除不再使用的上传票据。
4. 创建新照片顺序。
5. 设置新的封面。

任一步骤失败都必须回滚，不能出现机位存在但没有照片的中间状态。

### 8.3 提交举报

以下步骤放在同一个事务中：

1. 插入举报记录，依靠唯一约束抵御重复举报。
2. 统计该机位有效举报人数。
3. 达到 3 人且机位仍为 `active` 时，将其改为 `hidden`。

并发举报时允许多个事务重复尝试隐藏机位，但最终状态必须一致。

### 8.4 浏览量

使用单条原子更新：

```sql
UPDATE spots SET view_count = view_count + 1 WHERE id = ?;
```

浏览量更新失败不阻塞详情读取。若未来流量显著增长，再将浏览计数迁移到缓存或异步聚合系统。

## 9. 主要查询与索引对应关系

| 业务查询 | 主要条件/排序 | 目标索引 |
| --- | --- | --- |
| 地图视野 | `status='active'` + 空间包围盒 | `spx_spots_location`，再过滤状态 |
| 全国发现流 | `status` + `created_at,id` 游标 | `idx_spots_feed` |
| 城市发现流 | `status,city` + `created_at,id` 游标 | `idx_spots_city_feed` |
| 我的机位 | `user_id` + 时间游标，排除 deleted | `idx_spots_user_created` |
| 机位照片 | `spot_id` + `sort_order` | `uk_photos_spot_order` |
| 孤儿上传 | `spot_id IS NULL` + `created_at` | `idx_upload_tickets_orphan` |
| 机审超时 | `status='pending'` + `created_at` | `idx_content_tasks_poll` |
| 回调匹配 | `trace_id` | 唯一索引 |
| 待处理举报 | `status` + `created_at` | `idx_spot_reports_status_created` |

上线前必须对地图查询、全国发现流、城市发现流和“我的机位”执行 `EXPLAIN ANALYZE`。索引是否保留以
真实执行计划为准，不因文档存在就默认有效。

## 10. MySQL 参考 DDL

以下 DDL 是设计参考，不应在本阶段直接执行。正式迁移时应拆成可回滚、带校验和的迁移文件。

```sql
CREATE TABLE users (
  id           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  openid       VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nickname     VARCHAR(24) NULL,
  avatar_url   VARCHAR(512) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_openid (openid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE spots (
  id             CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id        CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  title          VARCHAR(40) NOT NULL,
  description    VARCHAR(1000) NOT NULL DEFAULT '',
  location       POINT NOT NULL SRID 0,
  lat            DOUBLE NOT NULL,
  lng            DOUBLE NOT NULL,
  province       VARCHAR(64) NULL,
  city           VARCHAR(64) NULL,
  district       VARCHAR(64) NULL,
  address        VARCHAR(256) NULL,
  heading        VARCHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
  focal_length   VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  difficulty     TINYINT UNSIGNED NOT NULL DEFAULT 1,
  access_note    VARCHAR(300) NULL,
  cover_photo_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status         VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'active',
  view_count     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                 ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_spots_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_spots_lat CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT chk_spots_lng CHECK (lng BETWEEN -180 AND 180),
  CONSTRAINT chk_spots_heading CHECK (
    heading IS NULL OR heading IN ('N','NE','E','SE','S','SW','W','NW')
  ),
  CONSTRAINT chk_spots_focal CHECK (
    focal_length IS NULL OR focal_length IN ('ultrawide','standard','tele','macro','drone')
  ),
  CONSTRAINT chk_spots_difficulty CHECK (difficulty BETWEEN 1 AND 3),
  CONSTRAINT chk_spots_status CHECK (status IN ('pending','active','hidden','deleted')),
  SPATIAL KEY spx_spots_location (location),
  KEY idx_spots_feed (status, created_at DESC, id DESC),
  KEY idx_spots_city_feed (status, city, created_at DESC, id DESC),
  KEY idx_spots_user_created (user_id, created_at DESC, id DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE spot_best_times (
  spot_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  best_time    VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sort_order   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (spot_id, best_time),
  UNIQUE KEY uk_spot_best_times_order (spot_id, sort_order),
  KEY idx_spot_best_times_value (best_time, spot_id),
  CONSTRAINT fk_spot_best_times_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT chk_spot_best_time CHECK (
    best_time IN ('sunrise','morning','noon','afternoon','sunset','blue_hour','night')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE spot_best_seasons (
  spot_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  season       VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sort_order   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (spot_id, season),
  UNIQUE KEY uk_spot_best_seasons_order (spot_id, sort_order),
  KEY idx_spot_best_seasons_value (season, spot_id),
  CONSTRAINT fk_spot_best_seasons_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT chk_spot_season CHECK (season IN ('spring','summer','autumn','winter'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE photos (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  spot_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key  VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime        VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  size_bytes  BIGINT UNSIGNED NULL,
  width       INT UNSIGNED NULL,
  height      INT UNSIGNED NULL,
  sort_order  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_photos_object_key (object_key),
  UNIQUE KEY uk_photos_spot_order (spot_id, sort_order),
  KEY idx_photos_user (user_id),
  CONSTRAINT fk_photos_spot FOREIGN KEY (spot_id) REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT fk_photos_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_photos_size CHECK (size_bytes IS NULL OR size_bytes > 0),
  CONSTRAINT chk_photos_width CHECK (width IS NULL OR width > 0),
  CONSTRAINT chk_photos_height CHECK (height IS NULL OR height > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE spots
  ADD CONSTRAINT fk_spots_cover_photo
  FOREIGN KEY (cover_photo_id) REFERENCES photos(id) ON DELETE SET NULL;

CREATE TABLE upload_tickets (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  object_key  VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mime        VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  size_bytes  BIGINT UNSIGNED NULL,
  width       INT UNSIGNED NULL,
  height      INT UNSIGNED NULL,
  spot_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  used_at     DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_upload_tickets_object_key (object_key),
  KEY idx_upload_tickets_orphan (spot_id, created_at),
  KEY idx_upload_tickets_user_created (user_id, created_at DESC),
  CONSTRAINT fk_upload_tickets_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_upload_tickets_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE SET NULL,
  CONSTRAINT chk_upload_tickets_size CHECK (size_bytes IS NULL OR size_bytes > 0),
  CONSTRAINT chk_upload_tickets_width CHECK (width IS NULL OR width > 0),
  CONSTRAINT chk_upload_tickets_height CHECK (height IS NULL OR height > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE content_check_tasks (
  id          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  spot_id     CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trace_id    VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status      VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'pending',
  attempts    INT UNSIGNED NOT NULL DEFAULT 0,
  detail      VARCHAR(500) NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
              ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_check_tasks_trace (trace_id),
  KEY idx_content_tasks_poll (status, created_at),
  KEY idx_content_tasks_spot (spot_id, status),
  CONSTRAINT fk_content_tasks_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT chk_content_tasks_status CHECK (status IN ('pending','pass','risky','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE spot_reports (
  id           CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  spot_id      CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reporter_id  CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason       VARCHAR(64) NOT NULL,
  detail       VARCHAR(200) NULL,
  status       VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'open',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
               ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_spot_reports_once (spot_id, reporter_id),
  KEY idx_spot_reports_status_created (status, created_at DESC),
  KEY idx_spot_reports_spot_status (spot_id, status),
  KEY idx_spot_reports_reporter (reporter_id),
  CONSTRAINT fk_spot_reports_spot FOREIGN KEY (spot_id)
    REFERENCES spots(id) ON DELETE CASCADE,
  CONSTRAINT fk_spot_reports_reporter FOREIGN KEY (reporter_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_spot_reports_status CHECK (status IN ('open','resolved','rejected'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE schema_migrations (
  name          VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  checksum      CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_ms  INT UNSIGNED NULL,
  applied_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

## 11. PostgreSQL 到 MySQL 的字段映射

| PostgreSQL | MySQL 目标 | 迁移规则 |
| --- | --- | --- |
| `uuid` | `CHAR(36)` ASCII | 保留原 UUID 文本 |
| `text` | 按业务长度使用 `VARCHAR` | 超长值迁移前预检 |
| `timestamptz` | `DATETIME(3)` | 统一转换为 UTC |
| `double precision` | `DOUBLE` | 原值迁移 |
| `integer` | `INT` 或 `BIGINT UNSIGNED` | 计数使用 BIGINT |
| `smallint` | `TINYINT UNSIGNED` | 用 CHECK 保证范围 |
| PostgreSQL enum | `VARCHAR` + `CHECK` | 保持原字符串值 |
| enum array | 关联表多行 | 按原数组下标生成 `sort_order` |
| `geography(Point,4326)` | `POINT SRID 0` | 不复制 PostGIS 二进制；由 `lng/lat` 重建 |
| 部分索引 | 普通复合索引 | 将等值条件放在索引首列 |

## 12. 数据迁移顺序

正式迁移数据时按以下依赖顺序导入：

1. `users`
2. `spots`，暂不写 `cover_photo_id`
3. `spot_best_times`
4. `spot_best_seasons`
5. `photos`
6. 回填 `spots.cover_photo_id`
7. `upload_tickets`
8. `content_check_tasks`
9. `spot_reports`

空间字段必须根据 `lng/lat` 重新生成，不直接复制 PostGIS 的 `geography` 内容。

迁移前预检：

- 是否存在非法或重复 UUID。
- 是否存在重复 `openid`、`object_key` 或重复举报。
- 是否存在照片所有者和机位作者不一致。
- 是否存在封面照片不属于当前机位。
- 是否存在数据库约束之外的状态值或枚举值。
- 是否存在超过目标 `VARCHAR` 长度的数据。
- 是否存在 `lat/lng` 与 PostGIS `location` 不一致。
- 是否存在无照片机位、孤儿照片或失效外键。

发现异常时先输出报告，不能静默截断或跳过数据。

## 13. 后端改造范围

后续编码阶段至少涉及：

- 将 `pg` 驱动替换为 MySQL Promise 连接池驱动。
- 重写 `DatabaseService` 的查询结果和事务接口。
- 重写迁移器及种子数据执行器。
- 将 `$1` 参数替换为 `?` 参数。
- 将 `RETURNING` 改为应用生成 UUID后插入，或使用独立查询。
- 将 `ON CONFLICT` 改成 `INSERT ... ON DUPLICATE KEY UPDATE` 或显式事务逻辑。
- 将 PostgreSQL 数组读写改为关联表读写。
- 将 PostGIS 视野查询改为 MySQL 空间包围盒查询。
- 将 `ANY(array)` 改为安全生成的 `IN (?,...)`。
- 将 PostgreSQL interval 表达式改为 `DATE_SUB` 或 `TIMESTAMPADD`。
- 将 `rowCount`、`rows`、`PoolClient` 等 `pg` 接口适配为 MySQL 驱动接口。
- 重写数据库端到端测试和测试数据库初始化。
- 更新 Docker、环境变量示例、部署说明和健康检查。

应用查询应集中在仓储层或清晰的数据库适配层，避免 MySQL 语法继续散落在业务服务中。

## 14. 远程数据库运行要求

### 14.1 网络和权限

- 优先通过云内网或专用网络连接数据库。
- 必须启用 TLS；生产环境应校验证书，不使用无条件跳过证书校验。
- 数据库不直接向公网开放；如无法避免，使用固定出口 IP 白名单。
- 运行账号只授予业务表的 `SELECT/INSERT/UPDATE/DELETE`。
- 迁移账号单独管理，才允许 `CREATE/ALTER/DROP/INDEX`。
- 禁止把连接串和密码提交到 Git。

### 14.2 会话设置

连接建立后统一设置或验证：

```text
time_zone = '+00:00'
character_set_client = utf8mb4
STRICT_TRANS_TABLES
NO_ZERO_DATE
NO_ZERO_IN_DATE
ERROR_FOR_DIVISION_BY_ZERO
```

生产连接池初始建议上限为 10，与当前配置保持一致；最终数值根据云数据库连接上限、API 实例数和压测结果计算。

### 14.3 备份与恢复

- 开启自动备份和时间点恢复（PITR）。
- 至少保留 7 天备份，正式上线前根据成本和业务要求确认最终保留期。
- 上线切换前制作一次完整 PostgreSQL 备份和一次 MySQL 快照。
- 必须实际演练恢复，而不是只确认“备份任务成功”。
- PostgreSQL 旧库在观察期内保持只读，不立即销毁。

## 15. 迁移实施建议

当前项目处于早期、数据量预计较小，建议采用可控停机迁移，而不是立即引入双写：

1. 完成 MySQL DDL 和数据库适配代码。
2. 在测试 MySQL 实例执行全量迁移演练。
3. 对表数量、行数、外键、枚举、坐标和抽样 API 结果做校验。
4. 上线时短暂进入维护模式，停止新写入。
5. 对 PostgreSQL 做最终备份并执行最终全量迁移。
6. 再次完成数据校验。
7. 将 API 连接切换到远程 MySQL。
8. 执行健康检查、创建/编辑/删除、地图视野、上传、举报和机审回调冒烟测试。
9. 观察稳定后再解除维护模式。
10. PostgreSQL 保持只读作为回滚源，观察期结束后再决定下线。

如果正式迁移前数据规模或写入量已经显著增长，再另行设计增量同步或双写方案。

## 16. 验收标准

### 16.1 结构验收

- 所有表、主键、外键、唯一约束和 CHECK 约束存在。
- 数据库字符集为 `utf8mb4`。
- 所有业务时间按 UTC 写入和读取。
- `SPATIAL INDEX` 能被地图视野查询使用。
- 迁移文件具有校验和且不可重复执行。

### 16.2 数据验收

- 每张表迁移前后行数符合转换规则。
- UUID、OpenID、对象存储 key 不发生变化。
- PostgreSQL 数组拆表后的元素数量和顺序一致。
- 所有外键均可验证，无孤儿记录。
- 所有 `cover_photo_id` 指向所属机位照片。
- `location` 与 `lat/lng` 一致。
- 时间转换前后的 UTC 时刻一致。

### 16.3 功能验收

- 微信登录可创建或读取用户。
- 全国发现流和城市发现流分页无重复、无遗漏。
- 地图视野查询和城市聚合结果正确。
- 创建机位、编辑机位和软删除事务完整。
- 1～9 张图片上传和顺序正确。
- 24 小时孤儿上传清理正确。
- 图片机审回调幂等，超时任务能被扫描。
- 同一用户不能重复举报，3 个不同用户举报后机位隐藏。
- 作者可以看到自己的 `pending/hidden` 机位，其他用户不可见。
- 数据库断开时健康检查能正确报告失败。

### 16.4 性能验收

- 对关键 SQL 保存 `EXPLAIN ANALYZE` 结果。
- 地图视野查询最多返回 500 条。
- 默认发现流每页 20 条，游标分页响应稳定。
- 数据库连接数不超过远程实例配额。
- 索引设计经过真实数据或放大数据集验证。

## 17. 回滚原则

- 切换前保留 PostgreSQL 完整备份和只读实例。
- MySQL 上线后若出现数据正确性问题，立即停止写入，不在两套数据库之间人工拼接数据。
- 若尚未产生新写入，可直接将 API 连接回 PostgreSQL。
- 若 MySQL 已产生新写入，回滚前必须先确定新增数据的回灌方案。
- 未通过数据验收和冒烟测试，不解除维护模式。

## 18. 后续交付物

按照本文继续实施时，应依次产出：

1. MySQL baseline 迁移文件。
2. PostgreSQL 数据预检报告工具。
3. PostgreSQL → MySQL 数据转换与导入工具。
4. MySQL 数据库适配层和业务 SQL 改造。
5. 新版种子数据与端到端测试。
6. 数据一致性验证报告。
7. 上线切换和回滚操作手册。

## 19. 官方参考

- [MySQL 8.0：Spatial Index Optimization](https://dev.mysql.com/doc/refman/8.0/en/spatial-index-optimization.html)
- [MySQL 8.0：Spatial Data Types](https://dev.mysql.com/doc/refman/8.0/en/spatial-type-overview.html)
- [MySQL 8.0：Spatial Reference System Support](https://dev.mysql.com/doc/refman/8.0/en/spatial-reference-systems.html)
- [MySQL 8.0：CHECK Constraints](https://dev.mysql.com/doc/refman/8.0/en/create-table.html)
- [MySQL 8.0：DATE、DATETIME 与 TIMESTAMP](https://dev.mysql.com/doc/refman/8.0/en/datetime.html)
- [MySQL 8.0：JSON Data Type](https://dev.mysql.com/doc/refman/8.0/en/json.html)


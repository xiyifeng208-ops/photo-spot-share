# 接口说明（prefix: `/api/v1`）

所有成功响应统一包一层 `data`，错误统一为 `error`：

```json
{ "data": { } }
{ "error": { "code": "BAD_REQUEST", "message": "标题至少 2 个字" } }
```

鉴权：除标注「公开」的接口外，都需要 `Authorization: Bearer <token>`。
错误码：`BAD_REQUEST(400)` / `UNAUTHORIZED(401)` / `FORBIDDEN(403)` / `NOT_FOUND(404)` /
`RATE_LIMITED(429)` / `GEO_UNAVAILABLE(502)` / `STORAGE_UNAVAILABLE(502)`。

## 鉴权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/wx-login` | 公开。body `{ code }`，用 `wx.login` 的 code 换 `{ token, user }`；本地开发用 `dev:<设备ID>`（需 `AUTH_DEV_MODE=true`） |
| GET | `/auth/me` | 当前用户资料 |
| PATCH | `/auth/me` | 更新 `nickname` / `avatarUrl`（微信新规需用户主动填写） |

## 地址服务

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/geo/reverse?lng=&lat=` | 逆地理编码，返回 `{ province, city, district, address, source, configured }`。限流 30 次/分钟/用户 |
| GET | `/geo/search?keyword=&city=` | POI 关键字搜索，用于按地标快速定位 |

`source`：`amap`（高德实时返回）、`cached`（命中服务端 10 分钟缓存）、`unavailable`（未配置 Key 的降级结果）。
`configured` 表示服务端是否配了高德 Key；配了但调用失败时返回 502，`message` 里会带**翻译过的原因**
（例如 `地址服务异常（USERKEY_PLAT_NOMATCH）：Key 与调用平台不匹配…`），常见错误码对照见 `docs/DEPLOY.md`。

## 打卡点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/spots?bbox=minLng,minLat,maxLng,maxLat&zoom=&limit=&viewerLat=&viewerLng=` | 公开。视野查询 |
| GET | `/spots/feed?city=&province=&district=&keyword=&cursor=&limit=` | 公开。城市、关键词与拍摄条件筛选，游标分页 |
| GET | `/spots/mine?cursor=&limit=` | 我创建的机位 |
| GET | `/spots/favorites?province=&city=&district=&cursor=&limit=` | 当前用户的想去清单，按收藏时间分页 |
| PUT | `/spots/:id/favorite` | 幂等收藏公开作品，返回 `{ isFavorited: true, favoriteCount }` |
| DELETE | `/spots/:id/favorite` | 幂等取消自己的收藏，返回 `{ isFavorited: false, favoriteCount }` |
| GET | `/spots/:id` | 公开。详情（含样张、拍摄参数、是否本人、`isFavorited`、`favoriteCount`） |
| POST | `/spots` | 创建，限流 20 次/天/用户 |
| PATCH | `/spots/:id` | 编辑，仅作者 |
| DELETE | `/spots/:id` | 软删除，仅作者 |
| POST | `/spots/:id/report` | 举报机位（非作者，同一人只能报一次），body `{ reason, detail? }` |

### 发现流筛选

`GET /api/v1/spots/feed` 保留原响应 `{ items, nextCursor }` 与 `viewerLat/viewerLng` 距离展示参数，仅返回 `active` 作品。`keyword` 去空格后非空时，按收藏数、发布时间、ID 依次倒序；无关键词（包括仅筛选城市或拍摄条件）仍按发布时间、ID 倒序。所有机位摘要及详情新增 `favoriteCount` 非负整数，无收藏为 `0`，匿名也可读取公开机位的数量。

- 所有筛选参数可选，条件之间为 AND。普通城市传 `province` 与 `city`；省直辖县级行政区传 `province` 与 `district`，不传 `city`，兼容城市字段为空的作品。
- `keyword` 去除首尾空格后最长 100 字，空白等同不搜索。对名称、省、市、区县、详细地址作包含匹配（不搜索经验说明）；`%`、`_`、反斜杠按普通文字处理，查询使用绑定参数。
- `province`、`district` 最长 64 字；非字符串或超长输入返回 400。区域按存储名称精确匹配，缺失区域信息的作品可在全部城市按名称或地址查找。
- 每次修改条件必须清空 `cursor`；下一页沿用同一组条件。切换全部城市时不传省、市、区县，关键词仍可保留。
- 上海示例：`/spots/feed?province=上海市&city=上海市&keyword=外滩`；仙桃示例：`/spots/feed?province=湖北省&district=仙桃市`。实际请求需 URL 编码。

此接口只搜索已有作品，不调用高德 POI 搜索，也不计算周边搜索半径。城市选项来自 `miniprogram/data/cities.js` 中的静态目录，更新方法见同目录 README。

关键词搜索使用专用游标，包含收藏数、完整精度发布时间和作品 ID；不要解析或与无关键词、其他列表游标混用。排序由后端针对完整筛选结果执行，不是小程序对当前页重排。收藏数是实时读取值，不锁定一次搜索的历史快照：翻页期间其他用户收藏或取消可能改变作品位置；小程序合并分页时去重，下拉刷新从最新排行开始。

#### 拍摄条件参数

以下参数以单个逗号分隔字符串传入，类别内 OR、类别之间及城市关键词之间 AND。不传或空白表示不限，重复值去重，非法枚举、重复 query 参数、非字符串及超过 200 字符返回 400。未填写时段、季节、焦段或难度的作品不匹配对应已选条件；不新增“未知难度”筛选参数。

| 参数 | 合法值 |
| --- | --- |
| `bestTimes` | `sunrise,morning,noon,afternoon,sunset,blue_hour,night` |
| `bestSeasons` | `spring,summer,autumn,winter` |
| `focalLengths` | `ultrawide,standard,tele,macro,drone` |
| `difficulties` | `1,2,3`（按指定难度匹配，不是最大难度） |

示例：`/spots/feed?city=上海市&bestTimes=sunset,night&difficulties=1`。实际发送时需 URL 编码。筛选使用参数化查询；是否按收藏数排序只取决于有无非空关键词。

### 收藏与想去清单

收藏接口必须登录，用户 ID 仅从鉴权身份取得。自己的公开作品也可收藏；重复 PUT 不创建重复记录、不更新原收藏时间。不存在或非公开作品不能新增收藏。DELETE 仅删除当前用户关系，作品下线或本就未收藏时仍可幂等取消。

清单响应为 `{ items, nextCursor }`，支持 `viewerLat/viewerLng`，按收藏时间和作品 ID 倒序，游标不可与发现流混用。省市区县参数与发现流区域规则相同，所有条件改变时重置游标。只展示公开作品；隐藏、审核中、软删除的收藏关系保留但不返回内容，恢复公开后再次可见。

详情的 `isFavorited` 是当前身份是否已收藏；匿名请求为 false。开发账号按设备区分，不承诺手机与开发工具的不同身份自动合并。

`favoriteCount` 是该作品现存收藏关系总数，不等于当前用户是否收藏，也不区分手机与电脑；同一账号至多计一次，不公开收藏者身份。PUT/DELETE 完成后返回服务端数量，前端据此更新，不用本地加减冒充服务器结果。隐藏作品的收藏关系保留、恢复公开后继续计数；数量不会改变内容公开限制。地图顺序、我的发布顺序及精选路线站序不变。

DELETE 对不存在、已删除或当前用户无权查看的非公开作品统一返回 `favoriteCount: 0`，避免借取消接口探测其收藏总量；隐藏或审核中作品的作者仍可读取真实数量。此处的 `0` 不表示其他用户的收藏关系被删除。

机位状态 `status`：`active`（已公开）/ `pending`（机审中，仅作者可见）/ `hidden`（已隐藏）/
`deleted`（已删除）。开启内容机审后，新发布的机位先进 `pending`，图片机审通过后自动转 `active`。
同一机位被 3 个不同用户举报会自动转 `hidden`。

视野查询返回：

```json
{
  "mode": "points",
  "zoom": 14,
  "truncated": false,
  "items": [],
  "clusters": []
}
```

- `zoom < 9` → `mode: "cluster"`，`clusters: [{ city, count, lat, lng }]`
- `zoom >= 9` → `mode: "points"`，`items` 为点位数组；`truncated: true` 表示达到上限（500），前端应提示放大地图

创建/编辑 body：

```json
{
  "title": "外滩 三件套压角机位",
  "description": "站在防汛墙内侧，用长焦…",
  "lat": 31.2397,
  "lng": 121.4903,
  "heading": "NE",
  "bestTimes": ["sunset", "blue_hour"],
  "bestSeasons": ["autumn"],
  "focalLength": "tele",
  "difficulty": 2,
  "accessNote": "地铁 2 号线南京东路站 2 号口出",
  "photoKeys": ["uploads/<userId>/20260916/xxxx.jpg"],
  "geo": { "province": "上海市", "city": "上海市", "district": "黄浦区", "address": "中山东一路" }
}
```

枚举取值：

- `heading`：`N NE E SE S SW W NW`
- `bestTimes`：`sunrise morning noon afternoon sunset blue_hour night`
- `bestSeasons`：`spring summer autumn winter`
- `focalLength`：`ultrawide standard tele macro drone`
- `difficulty`：`1`（轻松到达）/ `2`（需要步行）/ `3`（较难到达）/ `null`（暂不确定）。新建省略时也存为 `null`，摘要与详情的 `difficultyLabel` 返回“暂不确定”。

坐标统一为 **GCJ-02**，且 v1 仅支持中国大陆范围内的点。
新建及修改位置时必须有完整地区信息：普通地区为 `province + city`，省直辖县级地区为 `province + district`（`city` 可为空）。直辖市统一 `province/city`。提供信息不完整时尝试高德补全，仍不完整返回 400 提示手动确认。手填详细地址保留；更换地区时不沿用旧市或区县。合法地区来自项目随附的大陆静态目录，前后端目录同步更新。

### 编辑的清空语义

PATCH 中省略字段表示保留原值；`bestTimes: []`、`bestSeasons: []` 清空多选，`heading: null`、`focalLength: null`、`difficulty: null`、`accessNote: null` 清空对应字段，到达说明空白字符串同样清空。数组传 `null`、单选传非法枚举返回 400。只修改文字且不提交地区或变动坐标时，不强制补全历史地区；旧数据不会自动改写。

草稿不新增后端接口。小程序保存本机文字和照片，不长期保存上传票据，发布仍使用现有上传及创建接口。

## 精选摄影路线

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/routes` | 公开，返回 `{ items: RouteSummary[] }`，按配置顺序，首版不分页 |
| GET | `/routes/:id` | 公开，返回 `RouteDetail`；未知路线或不足两个有效机位时返回 404 |

`RouteSummary` 包含 `id/title/province/city/summary/theme/isDemo/disclaimer/updatedAt/coverUrl/stopCount/totalStopCount/unavailableCount`。`RouteDetail` 另外包含 `preparation: string[]`、`stops: [{ order, suggestedTime, note, spot }]`，`spot` 复用现有作品摘要；`order` 保留原配置站序。

路线配置在服务端；接口不接收城市、关键词或拍摄条件。只批量读取 `active` 且仍属于路线地区的作品，不因作者身份放行非公开作品，也不增加浏览量。不可用站点不返回其 ID、标题、地址和编排说明，仅返回不可用数量；少于两个有效站点时整条路线不可用。封面采用有效站点中的首张可用封面，无图时为空。

当前示例 ID 为 `shanghai-city-light-demo`。维护与配置校验见 [路线维护说明](ROUTES.md)。

## 近期机位反馈

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/spots/:id/feedback?cursor=&limit=` | 公开作品近 30 天的反馈，匿名可读；`limit` 默认 5，范围 1–20 |
| PUT | `/spots/:id/feedback` | 鉴权，body `{ kind }`；新增或更新本人的一条反馈，限流 20 次/小时/用户与路由 |
| DELETE | `/spots/:id/feedback` | 鉴权，幂等撤回本人的反馈，返回 `{ removed: true }` |

GET 返回 `{ items, nextCursor, myFeedback, windowDays: 30 }`；每条记录为 `{ id, kind, label, updatedAt, isMine }`，不公开用户 ID、昵称或登录标识。`myFeedback` 是当前账号近 30 天的反馈或 `null`，匿名为 `null`。PUT 返回 `{ feedback }`。

`kind` 仅允许 `still_accessible`（仍可拍摄）、`location_changed`（位置有变化）、`access_restricted`（入口受限）、`obstructed`（现场遮挡）。每人每机位最多一条，更新使用服务端时间。它表示反馈提交时间，不证明用户到访时间。

列表按 `updatedAt + id` 倒序游标分页，游标绑定机位；非法类型、游标、分页参数返回 400。所有记录都是未经核实的用户反馈，不提供自由文本、评分或自动认定；不修改作品字段、状态、浏览量及路线可用性。所有接口均要求机位处于 `active`，非公开或不存在时返回 404，作者身份不豁免。

## 拍摄时间助手

公开 `GET /spots/:id/shooting-times?date=YYYY-MM-DD`。省略日期默认北京时间当天，严格接受 2000-01-01 至 2100-12-31 的有效日期，非法值返回 400。仅公开作品可用，非公开或不存在时返回 404。

响应：`{ date, timeZone: "Asia/Shanghai", sunrise, sunset, goldenMorning, goldenEvening, blueMorning, blueEvening, notes, method }`。

- `sunrise/sunset` 为带 `+08:00` 的完整 ISO 时间或 `null`。
- 四个时段为 `{ start, end }`，端点同样使用带 `+08:00` 的完整 ISO 时间；当日不存在完整时段时为 `null`。
- `notes` 为使用限制说明；`method` 包含算法名称、坐标近似说明、太阳高度阈值与来源链接。

按机位坐标本地计算，不调用详情接口、不增加浏览量、不使用天气服务或新增 Key。详情及计算说明见 [拍摄时间计算说明](SHOOTING-TIMES.md)。

## 图片上传

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/uploads/photos/sign` | body `{ items: [{ mime, size, width, height }] }`，返回直传凭证与对象 key |
| POST | `/uploads/local` | 仅本地存储驱动可用：`multipart/form-data`，字段 `file` + `key`，服务端落盘 |

`STORAGE_DRIVER=cos` 时 `sign` 返回 `{ driver, bucket, region, credentials:{tmpSecretId,tmpSecretKey,sessionToken,expiredTime}, keys, urls }`，
临时密钥有效期 10 分钟且只允许写入 `uploads/{userId}/*`。

**地址跟随请求来源**：本地存储驱动返回的 `uploadUrl` 与图片地址，会按本次请求的 Host 生成
（用 `127.0.0.1` 访问就返回 `127.0.0.1`，用局域网 IP 访问就返回局域网 IP），
所以模拟器、真机局域网、电脑热点三种场景都不需要改配置。COS 驱动走 CDN 域名，不受影响。

完整发布流程：

1. `POST /uploads/photos/sign`（携带图片 mime/size）
2. 客户端直传图片到返回的 `keys`
3. `POST /spots` 带上 `photoKeys`
4. 超过 24 小时未被任何打卡点引用的图片会被定时任务清理

## 其他

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 公开。数据库与存储驱动健康状态（不带 `/api/v1` 前缀） |
| GET/POST | `/wechat/callback` | 公开。微信消息推送回调（URL 校验 + 图片机审结果），返回纯文本，不走统一响应包装 |

## 运营接口（需 header `x-admin-token`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/reports?status=open\|all&limit=` | 查看举报 |
| POST | `/admin/spots/:id/status` | body `{ status: "active"\|"hidden"\|"deleted" }` |
| POST | `/admin/spots/:id/resolve-reports` | body `{ resolution: "resolved"\|"rejected" }` |
| POST | `/admin/content-check/sweep` | 手动触发机审超时兜底 |

`ADMIN_TOKEN` 为空时整个 `/admin` 返回 403。

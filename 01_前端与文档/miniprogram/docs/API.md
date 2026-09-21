# 接口说明（prefix: `/api/v1`）

> 本文件为早期接口副本。最新的收藏、拍摄筛选、字段清空和摄影路线接口以项目根目录 [docs/API.md](../../docs/API.md) 为准。

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

## 打卡点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/spots?bbox=minLng,minLat,maxLng,maxLat&zoom=&limit=&viewerLat=&viewerLng=` | 公开。视野查询 |
| GET | `/spots/feed?city=&cursor=&limit=` | 公开。发现流，游标分页 |
| GET | `/spots/mine?cursor=&limit=` | 我创建的机位 |
| GET | `/spots/:id` | 公开。详情（含样张、拍摄参数、是否本人） |
| POST | `/spots` | 创建，限流 20 次/天/用户 |
| PATCH | `/spots/:id` | 编辑，仅作者 |
| DELETE | `/spots/:id` | 软删除，仅作者 |

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
  "photoKeys": ["uploads/<userId>/20260914/xxxx.jpg"],
  "geo": { "province": "上海市", "city": "上海市", "district": "黄浦区", "address": "中山东一路" }
}
```

枚举取值：

- `heading`：`N NE E SE S SW W NW`
- `bestTimes`：`sunrise morning noon afternoon sunset blue_hour night`
- `bestSeasons`：`spring summer autumn winter`
- `focalLength`：`ultrawide standard tele macro drone`
- `difficulty`：`1`（轻松到达）/ `2`（需要步行）/ `3`（较难到达）

坐标统一为 **GCJ-02**，且 v1 仅支持中国大陆范围内的点。

## 图片上传

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/uploads/photos/sign` | body `{ items: [{ mime, size, width, height }] }`，返回直传凭证与对象 key |
| POST | `/uploads/local` | 仅本地存储驱动可用：`multipart/form-data`，字段 `file` + `key`，服务端落盘 |

`STORAGE_DRIVER=cos` 时 `sign` 返回 `{ driver, bucket, region, credentials:{tmpSecretId,tmpSecretKey,sessionToken,expiredTime}, keys, urls }`，
临时密钥有效期 10 分钟且只允许写入 `uploads/{userId}/*`。

完整发布流程：

1. `POST /uploads/photos/sign`（携带图片 mime/size）
2. 客户端直传图片到返回的 `keys`
3. `POST /spots` 带上 `photoKeys`
4. 超过 24 小时未被任何打卡点引用的图片会被定时任务清理

## 其他

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 公开。数据库与存储驱动健康状态（不带 `/api/v1` 前缀） |

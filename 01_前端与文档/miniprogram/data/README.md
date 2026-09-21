# 发现页城市目录

`cities.js` 是可直接被小程序加载的静态 CommonJS 数据模块，不含 Key。来源：[高德行政区域查询](https://lbs.amap.com/api/webservice/guide/api/district)。抓取日期记录在 `updatedAt`（当前 2026-09-17）。

范围为中国大陆 31 个省级地区、369 个可选地区：直辖市、地级市、自治州、地区、盟以及省直辖县级行政区。不包含港澳台和普通区县；普通区县通过位置关键词搜索。

- `field: city`：使用省份与城市筛选。
- `field: district`：省直辖县级行政区，使用省份与区县筛选，不依赖城市字段。
- 展开菜单不联网；无作品的城市也能选择。

维护时在项目根目录运行（从 `api/.env` 读取服务端 Key，不写入生成文件）：

```powershell
.\.local\node\node.exe tools\refresh-city-catalog.mjs
.\.local\node\node.exe tools\test-discover-filters.mjs
```

更新后检查源数据与目录差异，并在微信开发者工具重新编译。不要手工修改生成文件或把真实 Key 写入文档。

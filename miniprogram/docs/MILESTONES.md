# 实施顺序与验收标准

对应方案里的 M0–M5。每完成一个里程碑都能独立验证，不需要等全部做完。

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| M0 | 工具链与仓库骨架 | `pnpm install` 成功；`pnpm test` 全绿；`docker compose up -d postgres` 起库成功 |
| M1 | 鉴权与建表迁移 | `pnpm migrate` 建出全部表与索引；`POST /auth/wx-login`（dev code）能拿到 token；`GET /auth/me` 返回用户 |
| M2 | 创建链路 | 申请上传凭证 → 上传图片 → `POST /spots` 成功；`upload_tickets` 回填 `spot_id`；无票据上传被拒 |
| M3 | 地图浏览与详情 | 地图按视野拉点；`zoom<9` 返回聚合；详情包含样张与拍摄参数；删除后地图不再出现 |
| M4 | 发现/我的与导航 | 发现流按城市筛选 + 上拉分页；我的机位可编辑/删除；详情页可拉起导航 |
| M5 | 上云与提审 | `/health` 正常；小程序能连正式域名；`wx.getLocation` 接口申请通过；提审通过 |

## 每个里程碑的验证命令

```bash
# M0 / M1
cd api && pnpm install && pnpm typecheck && pnpm test
docker compose -f ../deploy/docker-compose.yml up -d postgres
pnpm migrate && pnpm seed

# M2 / M3 / M4（带真实 PostGIS 的端到端用例）
TEST_DATABASE_URL=postgres://spot:spot@localhost:5432/spot pnpm test -- spots.e2e

# M5
curl -s https://api.example.com/health
```


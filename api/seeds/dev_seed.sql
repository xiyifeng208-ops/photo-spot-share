-- 本地开发种子数据：3 个用户 + 6 个打卡点（上海/杭州/重庆）
-- 通过 `pnpm seed` 执行，可重复运行（先按固定 uuid 清理）。

DELETE FROM spots WHERE id IN (
  '11111111-1111-4111-8111-000000000001',
  '11111111-1111-4111-8111-000000000002',
  '11111111-1111-4111-8111-000000000003',
  '11111111-1111-4111-8111-000000000004',
  '11111111-1111-4111-8111-000000000005',
  '11111111-1111-4111-8111-000000000006'
);

INSERT INTO users (id, openid, nickname, avatar_url) VALUES
  ('22222222-2222-4222-8222-000000000001', 'dev:alice', '爱拍的小艾', NULL),
  ('22222222-2222-4222-8222-000000000002', 'dev:bob',   '城市漫游者', NULL),
  ('22222222-2222-4222-8222-000000000003', 'dev:carol', '胶片旅人',   NULL)
ON CONFLICT (openid) DO NOTHING;

INSERT INTO spots (
  id, user_id, title, description, lat, lng, location,
  province, city, district, address,
  heading, best_times, best_seasons, focal_length, difficulty, access_note
) VALUES
(
  '11111111-1111-4111-8111-000000000001',
  (SELECT id FROM users WHERE openid = 'dev:alice'),
  '外滩 三件套压角机位',
  '站在防汛墙内侧，用长焦把东方明珠收到画面右上角，江面留出倒影区。人少的时候可以蹲下来拍栏杆做前景。',
  31.239700, 121.490300, ST_SetSRID(ST_MakePoint(121.490300, 31.239700), 4326)::geography,
  '上海市', '上海市', '黄浦区', '中山东一路滨江步道',
  'NE', '{sunset,blue_hour}'::spot_best_time[], '{spring,autumn}'::spot_season[], 'tele', 1,
  '地铁 2/10 号线南京东路站 2 号口出，沿南京东路向东步行约 12 分钟'
),
(
  '11111111-1111-4111-8111-000000000002',
  (SELECT id FROM users WHERE openid = 'dev:bob'),
  '武康大楼 街角对称机位',
  '淮海中路与武康路交叉口的西南角，站上台阶可以拍到建筑正立面对称构图，早晚两侧光影差异很大。',
  31.209900, 121.437100, ST_SetSRID(ST_MakePoint(121.437100, 31.209900), 4326)::geography,
  '上海市', '上海市', '徐汇区', '淮海中路 1842 号路口',
  'SW', '{morning,afternoon}'::spot_best_time[], '{spring,autumn,winter}'::spot_season[], 'standard', 2,
  '地铁 10/11 号线交通大学站 1 号口出，步行约 5 分钟'
),
(
  '11111111-1111-4111-8111-000000000003',
  (SELECT id FROM users WHERE openid = 'dev:carol'),
  '西湖 断桥晨雾',
  '清晨 5:30 前到达，湖面常起薄雾，把断桥放在画面下三分之一，用长焦压缩远山层次。',
  30.259400, 120.143800, ST_SetSRID(ST_MakePoint(120.143800, 30.259400), 4326)::geography,
  '浙江省', '杭州市', '西湖区', '白堤东端断桥残雪',
  'W', '{sunrise,morning}'::spot_best_time[], '{spring,summer,winter}'::spot_season[], 'tele', 1,
  '地铁 1 号线武林广场站换乘 7 路公交至少年宫站，步行至白堤'
),
(
  '11111111-1111-4111-8111-000000000004',
  (SELECT id FROM users WHERE openid = 'dev:alice'),
  '重庆 李子坝轻轨穿楼',
  '在观景平台左侧的斜坡上拍摄，可以避开人群并让轻轨与楼体形成对角线。建议抓 3 分钟一趟的进站节奏。',
  29.555900, 106.518400, ST_SetSRID(ST_MakePoint(106.518400, 29.555900), 4326)::geography,
  '重庆市', '重庆市', '渝中区', '李子坝正街轻轨观景平台',
  'S', '{morning,afternoon,night}'::spot_best_time[], '{spring,summer,autumn,winter}'::spot_season[], 'standard', 1,
  '轨道 2 号线李子坝站 1 号口出，跟随指示牌下到观景平台'
),
(
  '11111111-1111-4111-8111-000000000005',
  (SELECT id FROM users WHERE openid = 'dev:bob'),
  '陆家嘴 天桥车流长曝',
  '环廊天桥上以 21:00 后的车流做光轨，三脚架贴紧玻璃减少反光，用广角收纳环球金融中心与上海中心。',
  31.235400, 121.505400, ST_SetSRID(ST_MakePoint(121.505400, 31.235400), 4326)::geography,
  '上海市', '上海市', '浦东新区', '世纪大道陆家嘴环廊天桥',
  'N', '{night,blue_hour}'::spot_best_time[], '{spring,autumn,winter}'::spot_season[], 'ultrawide', 2,
  '地铁 2 号线陆家嘴站 5 号口出，上天桥后往西侧走'
),
(
  '11111111-1111-4111-8111-000000000006',
  (SELECT id FROM users WHERE openid = 'dev:carol'),
  '洱海 日出礁石机位',
  '环海西路一侧的礁石群，退潮时可以站到水边，用无人机贴水拍摄能拍到完整的山影倒影。',
  25.782100, 100.183200, ST_SetSRID(ST_MakePoint(100.183200, 25.782100), 4326)::geography,
  '云南省', '大理白族自治州', '大理市', '环海西路磻溪村段',
  'E', '{sunrise}'::spot_best_time[], '{autumn,winter,spring}'::spot_season[], 'drone', 3,
  '建议自驾，磻溪村停车场步行约 8 分钟；礁石湿滑请穿防滑鞋'
)
ON CONFLICT (id) DO NOTHING;


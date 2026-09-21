/**
 * 项目内人工维护的精选摄影路线。修改后重启开发 API／重新生产构建。
 * 这里只引用已有机位 UUID，不复制作品内容、不创建机位、不执行 seed。
 * 来源：api/seeds/dev_seed.sql 中的演示机位及拍摄时段；编排未经实地验证。
 */
export interface CuratedRouteStop {
  spotId: string;
  suggestedTime: string;
  note: string;
}

export interface CuratedRoute {
  id: string;
  title: string;
  province: string;
  city: string;
  summary: string;
  theme: string;
  isDemo: boolean;
  disclaimer: string;
  updatedAt: string;
  preparation: string[];
  stops: CuratedRouteStop[];
}

export const CURATED_ROUTES = Symbol('CURATED_ROUTES');

export const ROUTE_CATALOG: CuratedRoute[] = [{
  id: 'shanghai-city-light-demo',
  title: '上海城市光影示例线',
  province: '上海市',
  city: '上海市',
  summary: '从街角建筑到滨江天际线，再到夜间车流，按作品已有拍摄时段串联三个机位。',
  theme: '城市建筑 · 日落 · 夜景',
  isDemo: true,
  disclaimer: '演示编排，未经实地验证。时段仅供参考，不代表实时光线、开放或通行情况；请在出行前自行核实。',
  updatedAt: '2026-09-18',
  preparation: [
    '先打开各机位详情，确认样张、拍摄条件和到达提示，再决定是否加入自己的想去清单。',
    '各站并非连续步行路线，跨江及其他站间交通请另行确认；本页不提供距离、耗时或自动路线规划。',
    '根据所选机位准备器材，并确认现场是否允许架设三脚架；注意人流、车流及现场管理要求。',
  ],
  stops: [{
    spotId: '11111111-1111-4111-8111-000000000002',
    suggestedTime: '建议下午',
    note: '先观察建筑立面的光影，参考作品中的对称构图思路。',
  }, {
    spotId: '11111111-1111-4111-8111-000000000001',
    suggestedTime: '建议日落或蓝调时段',
    note: '转向滨江城市轮廓，参考作品中的长焦压缩与前景取舍。',
  }, {
    spotId: '11111111-1111-4111-8111-000000000005',
    suggestedTime: '建议夜景时段',
    note: '以夜间车流和高楼为主题，拍摄前确认现场安全与器材使用限制。',
  }],
}];

export function validateRouteCatalog(catalog: CuratedRoute[]): void {
  if (!Array.isArray(catalog) || catalog.length > 50) throw new Error('路线目录须为最多 50 条路线的数组');
  const ids = new Set<string>();
  const requireText = (value: unknown, max: number, field: string) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
      throw new Error(`路线配置 ${field} 必须为 1-${max} 字的文字`);
    }
  };
  for (const route of catalog) {
    if (!route || typeof route !== 'object') throw new Error('路线配置必须为对象');
    if (typeof route.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route.id) || route.id.length > 64) {
      throw new Error('路线 id 须为不超过 64 字符的小写字母、数字及短横线');
    }
    if (ids.has(route.id)) throw new Error(`重复的路线 id：${route.id}`);
    ids.add(route.id);
    requireText(route.title, 80, 'title');
    requireText(route.province, 64, 'province');
    requireText(route.city, 64, 'city');
    requireText(route.summary, 500, 'summary');
    requireText(route.theme, 100, 'theme');
    requireText(route.disclaimer, 500, 'disclaimer');
    if (typeof route.isDemo !== 'boolean') throw new Error('路线 isDemo 须为布尔值');
    if (typeof route.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(route.updatedAt)
      || Number.isNaN(Date.parse(route.updatedAt))
      || new Date(route.updatedAt).toISOString().slice(0, 10) !== route.updatedAt) {
      throw new Error('路线 updatedAt 须为有效 YYYY-MM-DD 日期');
    }
    if (!Array.isArray(route.preparation) || !route.preparation.length || route.preparation.length > 10) {
      throw new Error('路线 preparation 须包含 1-10 条提示');
    }
    route.preparation.forEach(item => requireText(item, 500, 'preparation'));
    if (!Array.isArray(route.stops) || route.stops.length < 2 || route.stops.length > 20) {
      throw new Error('每条路线须配置 2-20 个机位');
    }
    const spots = new Set<string>();
    for (const stop of route.stops) {
      if (!stop || typeof stop.spotId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stop.spotId)) {
        throw new Error('路线机位 spotId 须为有效 UUID');
      }
      if (spots.has(stop.spotId.toLowerCase())) throw new Error(`路线 ${route.id} 内机位重复`);
      spots.add(stop.spotId.toLowerCase());
      requireText(stop.suggestedTime, 100, 'suggestedTime');
      requireText(stop.note, 500, 'note');
    }
  }
}

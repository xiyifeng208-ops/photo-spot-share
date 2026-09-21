import { ROUTE_CATALOG, validateRouteCatalog } from './routes.catalog';

// 只检查项目内配置，不连接数据库、不启动 API、不创建或修改机位。
validateRouteCatalog(ROUTE_CATALOG);
console.log(`路线配置校验通过：${ROUTE_CATALOG.length} 条路线，${ROUTE_CATALOG.reduce((sum, route) => sum + route.stops.length, 0)} 个编排站点。`);

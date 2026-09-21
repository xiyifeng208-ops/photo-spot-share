import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../common/errors';
import { SpotsService, type SpotSummary } from '../spots/spots.service';
import { CURATED_ROUTES, type CuratedRoute, validateRouteCatalog } from './routes.catalog';

export interface RouteSummary {
  id: string;
  title: string;
  province: string;
  city: string;
  summary: string;
  theme: string;
  isDemo: boolean;
  disclaimer: string;
  updatedAt: string;
  coverUrl: string | null;
  stopCount: number;
  totalStopCount: number;
  unavailableCount: number;
}

export interface RouteDetail extends RouteSummary {
  preparation: string[];
  stops: { order: number; suggestedTime: string; note: string; spot: SpotSummary }[];
}

@Injectable()
export class RoutesService {
  constructor(
    private readonly spots: SpotsService,
    @Inject(CURATED_ROUTES) private readonly catalog: CuratedRoute[],
  ) {
    validateRouteCatalog(catalog);
  }

  async list(): Promise<{ items: RouteSummary[] }> {
    if (!this.catalog.length) return { items: [] };
    const spotMap = await this.publicSpots(this.catalog);
    const items = this.catalog.map(route => this.compose(route, spotMap))
      .filter((route): route is RouteDetail => route !== null)
      .map(({ stops: _stops, preparation: _preparation, ...summary }) => summary);
    return { items };
  }

  async detail(id: string): Promise<RouteDetail> {
    const route = this.catalog.find(item => item.id === id);
    if (!route) throw AppException.notFound('路线不存在或暂不可用');
    const detail = this.compose(route, await this.publicSpots([route]));
    if (!detail) throw AppException.notFound('路线可用机位不足，暂不可用');
    return detail;
  }

  private async publicSpots(routes: CuratedRoute[]): Promise<Map<string, SpotSummary>> {
    const ids = [...new Set(routes.flatMap(route => route.stops.map(stop => stop.spotId.toLowerCase())))];
    const spots = await this.spots.findPublicByIds(ids);
    return new Map(spots.filter(spot => spot.status === 'active').map(spot => [spot.id.toLowerCase(), spot]));
  }

  private compose(route: CuratedRoute, spotMap: Map<string, SpotSummary>): RouteDetail | null {
    const stops: RouteDetail['stops'] = [];
    route.stops.forEach((stop, index) => {
      const spot = spotMap.get(stop.spotId.toLowerCase());
      // 编辑后移到其他城市的机位也不沿用旧编排；非公开机位不透传任何站点文案。
      if (!spot || spot.province !== route.province || spot.city !== route.city) return;
      stops.push({ order: index + 1, suggestedTime: stop.suggestedTime, note: stop.note, spot });
    });
    if (stops.length < 2) return null;
    return {
      id: route.id, title: route.title, province: route.province, city: route.city,
      summary: route.summary, theme: route.theme, isDemo: route.isDemo,
      disclaimer: route.disclaimer, updatedAt: route.updatedAt,
      coverUrl: stops.find(stop => stop.spot.coverUrl)?.spot.coverUrl ?? null,
      stopCount: stops.length, totalStopCount: route.stops.length,
      unavailableCount: route.stops.length - stops.length,
      preparation: route.preparation.slice(), stops,
    };
  }
}

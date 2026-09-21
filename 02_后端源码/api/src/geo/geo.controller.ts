import { Controller, Get, Inject, Query } from '@nestjs/common';
import { AppException } from '../common/errors';
import { RateLimit } from '../common/guards/rate-limit.guard';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';
import { GeoService } from './geo.service';

@Controller('geo')
export class GeoController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly geoService: GeoService,
  ) {}

  @Get('reverse')
  @RateLimit({ scope: 'user-and-route', limit: 30, windowMs: 60_000 })
  async reverse(@Query('lng') lng: string, @Query('lat') lat: string) {
    const parsedLng = Number(lng);
    const parsedLat = Number(lat);
    if (!Number.isFinite(parsedLng) || !Number.isFinite(parsedLat)) {
      throw AppException.badRequest('lng / lat 必须是数字');
    }
    const meta = await this.geoService.reverse(parsedLat, parsedLng);
    return { ...meta, configured: this.geoService.isConfigured };
  }

  @Get('search')
  @RateLimit({ scope: 'user-and-route', limit: 30, windowMs: 60_000 })
  async search(@Query('keyword') keyword: string, @Query('city') city?: string) {
    if (!keyword) throw AppException.badRequest('缺少 keyword 参数');
    const items = await this.geoService.searchPoi(keyword, city);
    return { items, configured: this.geoService.isConfigured };
  }
}


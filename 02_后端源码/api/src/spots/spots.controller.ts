import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public, type RequestUser } from '../common/guards/jwt-auth.guard';
import { RateLimit } from '../common/guards/rate-limit.guard';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';
import {
  CreateSpotDto,
  ListFeedQueryDto,
  ListFavoritesQueryDto,
  ListSpotsQueryDto,
  ReportSpotDto,
  UpdateSpotDto,
} from './dto/spot.dto';
import { SpotsService } from './spots.service';
import { ModerationService } from './moderation.service';

@Controller('spots')
export class SpotsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly spotsService: SpotsService,
    private readonly moderation: ModerationService,
  ) {}

  /** 地图视野查询。未登录也能浏览。 */
  @Public()
  @Get()
  async list(
    @Query() query: ListSpotsQueryDto,
    @Query('viewerLat') viewerLat?: string,
    @Query('viewerLng') viewerLng?: string,
  ) {
    const viewer = toLatLng(viewerLat, viewerLng);
    return this.spotsService.findInView({
      bboxRaw: query.bbox,
      zoomRaw: query.zoom,
      limitRaw: query.limit,
      viewer,
    });
  }

  @Public()
  @Get('feed')
  async feed(@Query() query: ListFeedQueryDto, @Query('viewerLat') viewerLat?: string, @Query('viewerLng') viewerLng?: string) {
    return this.spotsService.findFeed({
      city: query.city,
      province: query.province,
      district: query.district,
      keyword: query.keyword,
      bestTimes: query.bestTimes,
      bestSeasons: query.bestSeasons,
      focalLengths: query.focalLengths,
      difficulties: query.difficulties,
      cursor: query.cursor,
      limitRaw: query.limit,
      viewer: toLatLng(viewerLat, viewerLng),
    });
  }

  @Get('mine')
  async mine(
    @CurrentUser() user: RequestUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.spotsService.findMine(user.id, cursor, limit);
  }

  @Get('favorites')
  favorites(
    @CurrentUser() user: RequestUser,
    @Query() query: ListFavoritesQueryDto,
    @Query('viewerLat') viewerLat?: string,
    @Query('viewerLng') viewerLng?: string,
  ) {
    return this.spotsService.findFavorites(user.id, {
      province: query.province,
      city: query.city,
      district: query.district,
      cursor: query.cursor,
      limitRaw: query.limit,
      viewer: toLatLng(viewerLat, viewerLng),
    });
  }

  @Put(':id/favorite')
  favorite(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
  ) {
    return this.spotsService.addFavorite(user.id, id);
  }

  @Delete(':id/favorite')
  unfavorite(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
  ) {
    return this.spotsService.removeFavorite(user.id, id);
  }

  @Public()
  @Get(':id')
  async detail(
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @CurrentUser(false) user?: RequestUser,
    @Query('viewerLat') viewerLat?: string,
    @Query('viewerLng') viewerLng?: string,
  ) {
    return this.spotsService.findDetail(id, user?.id, toLatLng(viewerLat, viewerLng));
  }

  @Post()
  @RateLimit({
    scope: 'user-and-route',
    limit: 20,
    windowMs: 24 * 60 * 60 * 1000,
  })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateSpotDto) {
    return this.spotsService.create(user, dto);
  }

  /** 举报机位（非作者）。同一个人对同一个机位只能报一次。 */
  @Post(':id/report')
  @RateLimit({ scope: 'user', limit: 10, windowMs: 60 * 60 * 1000 })
  report(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Body() dto: ReportSpotDto,
  ) {
    return this.moderation.reportSpot({
      spotId: id,
      reporterId: user.id,
      reason: dto.reason,
      detail: dto.detail,
    });
  }

  @Patch(':id')
  update(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Body() dto: UpdateSpotDto,
  ) {
    return this.spotsService.update(user.id, id, dto);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: RequestUser,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
  ) {
    return this.spotsService.softDelete(user.id, id);
  }
}

function toLatLng(lat?: string, lng?: string) {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
  return { lat: parsedLat, lng: parsedLng };
}

import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  BEST_TIME_LABELS,
  DIFFICULTY_LABELS,
  FOCAL_LENGTH_LABELS,
  HEADING_LABELS,
  SEASON_LABELS,
  type BestTime,
  type FocalLength,
  type Heading,
  type Season,
} from '../common/enums';
import { AppException } from '../common/errors';
import {
  bboxToWkt,
  CLUSTER_ZOOM_THRESHOLD,
  clampZoom,
  distanceInMeters,
  isInMainlandChina,
  normalizeLimit,
  type Bbox,
  type LatLng,
  parseBbox,
} from '../common/utils/geo.util';
import { decodeCursor, encodeCursor } from '../common/utils/cursor.util';
import { DatabaseService } from '../database/database.service';
import { GeoService } from '../geo/geo.service';
import { StorageService } from '../storage/storage.service';
import { UploadsService } from '../uploads/uploads.service';
import { ContentCheckService } from './content-check.service';
import type { CreateSpotDto, GeoMetaDto, UpdateSpotDto } from './dto/spot.dto';

interface SpotRow {
  id: string;
  user_id: string;
  title: string;
  description: string;
  lat: number;
  lng: number;
  province: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  heading: Heading | null;
  best_times: BestTime[] | null;
  best_seasons: Season[] | null;
  focal_length: FocalLength | null;
  difficulty: number;
  access_note: string | null;
  cover_photo_id: string | null;
  status: 'active' | 'hidden' | 'deleted';
  view_count: number;
  created_at: Date;
  updated_at: Date;
  nickname: string | null;
  avatar_url: string | null;
  cover_key: string | null;
}

interface PhotoRow {
  id: string;
  object_key: string;
  width: number | null;
  height: number | null;
  sort_order: number;
}

interface ClusterRow {
  city: string;
  count: number;
  lat: number;
  lng: number;
}

export interface SpotSummary {
  id: string;
  title: string;
  lat: number;
  lng: number;
  city: string | null;
  district: string | null;
  difficulty: number;
  difficultyLabel: string;
  heading: Heading | null;
  headingLabel: string | null;
  bestTimes: BestTime[];
  bestTimeLabels: string[];
  coverUrl: string | null;
  distanceMeters: number | null;
  author: { nickname: string | null; avatarUrl: string | null };
  createdAt: string;
}

export interface SpotDetail extends SpotSummary {
  description: string;
  province: string | null;
  address: string | null;
  bestSeasons: Season[];
  bestSeasonLabels: string[];
  focalLength: FocalLength | null;
  focalLengthLabel: string | null;
  accessNote: string | null;
  viewCount: number;
  photos: { key: string; url: string; width: number | null; height: number | null }[];
  isMine: boolean;
}

export interface ClusterPoint {
  city: string;
  count: number;
  lat: number;
  lng: number;
}

const SPOT_SELECT = `
  SELECT s.id, s.user_id, s.title, s.description, s.lat, s.lng,
         s.province, s.city, s.district, s.address,
         s.heading, s.best_times::text[] AS best_times,
         s.best_seasons::text[] AS best_seasons, s.focal_length,
         s.difficulty, s.access_note, s.cover_photo_id, s.status,
         s.view_count, s.created_at, s.updated_at,
         u.nickname, u.avatar_url,
         cp.object_key AS cover_key
    FROM spots s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN photos cp ON cp.id = s.cover_photo_id
`;

/**
 * 枚举数组兜底解析：正常情况下 SQL 里的 ::text[] 已经让驱动返回 JS 数组，
 * 这里额外兼容驱动/类型注册差异返回 `'{sunset,night}'` 字符串的情况。
 */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const body = value.slice(1, -1);
    if (!body) return [];
    return body.split(',').map((item) => item.replace(/^"|"$/g, ''));
  }
  return [];
}

@Injectable()
export class SpotsService {
  private readonly logger = new Logger(SpotsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
    private readonly uploads: UploadsService,
    private readonly geo: GeoService,
    private readonly contentCheck: ContentCheckService,
  ) {}

  /** 视野内点位；低 zoom 走城市聚合，避免全国视图一次拉几千个 marker。 */
  async findInView(params: {
    bboxRaw: string;
    zoomRaw?: string;
    limitRaw?: string;
    viewer?: LatLng | null;
  }): Promise<{
    mode: 'cluster' | 'points';
    zoom: number;
    truncated: boolean;
    clusters: ClusterPoint[];
    items: SpotSummary[];
  }> {
    const bbox: Bbox = this.parseBboxOrBadRequest(params.bboxRaw);
    const zoom = clampZoom(params.zoomRaw);
    const limit = normalizeLimit(params.limitRaw);

    if (zoom < CLUSTER_ZOOM_THRESHOLD) {
      const clusters = await this.findClusters(bbox, limit);
      return { mode: 'cluster', zoom, truncated: false, clusters, items: [] };
    }

    const { rows } = await this.db.query<SpotRow>(
      `${SPOT_SELECT}
        WHERE s.status = 'active'
          AND s.location && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
        ORDER BY s.created_at DESC
        LIMIT $5`,
      [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat, limit],
    );

    return {
      mode: 'points',
      zoom,
      truncated: rows.length >= limit,
      clusters: [],
      items: rows.map((row) => this.toSummary(row, params.viewer)),
    };
  }

  private async findClusters(bbox: Bbox, limit: number): Promise<ClusterPoint[]> {
    const { rows } = await this.db.query<ClusterRow>(
      `SELECT COALESCE(s.city, '未知地区') AS city,
              count(*)::int AS count,
              avg(s.lat) AS lat,
              avg(s.lng) AS lng
         FROM spots s
        WHERE s.status = 'active'
          AND s.location && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
        GROUP BY COALESCE(s.city, '未知地区')
        ORDER BY count DESC
        LIMIT $5`,
      [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat, limit],
    );

    return rows.map((row) => ({
      city: row.city,
      count: row.count,
      lat: Number(row.lat),
      lng: Number(row.lng),
    }));
  }

  async findDetail(id: string, viewerId?: string, viewer?: LatLng | null): Promise<SpotDetail> {
    const row = await this.db.queryOne<SpotRow>(`${SPOT_SELECT} WHERE s.id = $1`, [id]);
    if (!row || row.status === 'deleted') {
      throw AppException.notFound('该打卡点不存在或已被删除');
    }
    if (row.status === 'hidden' && row.user_id !== viewerId) {
      throw AppException.notFound('该打卡点正在审核中');
    }

    const { rows: photos } = await this.db.query<PhotoRow>(
      `SELECT id, object_key, width, height, sort_order
         FROM photos WHERE spot_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [id],
    );

    // 浏览量用异步自增，失败不影响详情读取
    this.db
      .query('UPDATE spots SET view_count = view_count + 1 WHERE id = $1', [id])
      .catch((error: Error) => this.logger.warn(`浏览量自增失败: ${error.message}`));

    const summary = this.toSummary(row, viewer);
    return {
      ...summary,
      description: row.description,
      province: row.province,
      address: row.address,
      bestSeasons: toStringArray(row.best_seasons) as Season[],
      bestSeasonLabels: (toStringArray(row.best_seasons) as Season[]).map(
        (item) => SEASON_LABELS[item],
      ),
      focalLength: row.focal_length,
      focalLengthLabel: row.focal_length ? FOCAL_LENGTH_LABELS[row.focal_length] : null,
      accessNote: row.access_note,
      viewCount: row.view_count + 1,
      photos: photos.map((photo) => ({
        key: photo.object_key,
        url: this.storage.publicUrl(photo.object_key),
        width: photo.width,
        height: photo.height,
      })),
      isMine: viewerId === row.user_id,
    };
  }

  /** 发现流：按城市筛选，游标分页，用于列表页。 */
  async findFeed(params: {
    city?: string;
    cursor?: string;
    limitRaw?: string;
    viewerId?: string;
    viewer?: LatLng | null;
  }): Promise<{ items: SpotSummary[]; nextCursor: string | null }> {
    const limit = normalizeLimit(params.limitRaw, 20);
    const cursor = decodeCursor(params.cursor);

    const { rows } = await this.db.query<SpotRow>(
      `${SPOT_SELECT}
        WHERE s.status = 'active'
          AND ($1::text IS NULL OR s.city = $1)
          AND (
            $2::timestamptz IS NULL
            OR (s.created_at, s.id) < ($2::timestamptz, $3::uuid)
          )
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $4`,
      [params.city?.trim() || null, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
    );

    const last = rows.at(-1);
    return {
      items: rows.map((row) => this.toSummary(row, params.viewer)),
      nextCursor:
        rows.length >= limit && last
          ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
          : null,
    };
  }

  async findMine(
    userId: string,
    cursorRaw?: string,
    limitRaw?: string,
  ): Promise<{ items: SpotSummary[]; nextCursor: string | null }> {
    const limit = normalizeLimit(limitRaw, 20);
    const cursor = decodeCursor(cursorRaw);

    const { rows } = await this.db.query<SpotRow>(
      `${SPOT_SELECT}
        WHERE s.user_id = $1
          AND s.status <> 'deleted'
          AND ($2::timestamptz IS NULL OR (s.created_at, s.id) < ($2::timestamptz, $3::uuid))
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $4`,
      [userId, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
    );

    const last = rows.at(-1);
    return {
      items: rows.map((row) => this.toSummary(row)),
      nextCursor:
        rows.length >= limit && last
          ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id })
          : null,
    };
  }

  async create(userId: string, dto: CreateSpotDto): Promise<SpotDetail> {
    this.assertCoordinates(dto.lat, dto.lng);
    const meta = await this.resolveGeoMeta(dto.lat, dto.lng, dto.geo);
    const audit = await this.contentCheck.checkText(
      userId,
      `${dto.title} ${dto.description ?? ''} ${dto.accessNote ?? ''}`,
    );
    const status = audit.pass ? 'active' : 'hidden';

    const spotId = await this.db.withTransaction(async (client) => {
      await this.uploads.assertUsableKeys(userId, dto.photoKeys, { client });

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO spots (
           user_id, title, description, location, lat, lng,
           province, city, district, address,
           heading, best_times, best_seasons, focal_length, difficulty, access_note, status
         ) VALUES (
           $1, $2, $3, ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography, $4, $5,
           $6, $7, $8, $9,
           $10, $11::spot_best_time[], $12::spot_season[], $13, $14, $15, $16::spot_status
         )
         RETURNING id`,
        [
          userId,
          dto.title.trim(),
          dto.description?.trim() ?? '',
          dto.lat,
          dto.lng,
          meta.province,
          meta.city,
          meta.district,
          meta.address,
          dto.heading ?? null,
          dto.bestTimes ?? [],
          dto.bestSeasons ?? [],
          dto.focalLength ?? null,
          dto.difficulty ?? 1,
          dto.accessNote?.trim() || null,
          status,
        ],
      );
      const id = rows[0].id;
      await this.attachPhotos(client, userId, id, dto.photoKeys);
      return id;
    });

    return this.findDetail(spotId, userId);
  }

  async update(userId: string, id: string, dto: UpdateSpotDto): Promise<SpotDetail> {
    const existing = await this.db.queryOne<SpotRow>(
      'SELECT id, user_id, lat, lng, status FROM spots WHERE id = $1',
      [id],
    );
    if (!existing || existing.status === 'deleted') {
      throw AppException.notFound('该打卡点不存在或已被删除');
    }
    if (existing.user_id !== userId) {
      throw AppException.forbidden('只能编辑自己创建的打卡点');
    }

    const nextLat = dto.lat ?? Number(existing.lat);
    const nextLng = dto.lng ?? Number(existing.lng);
    if (dto.lat !== undefined || dto.lng !== undefined) {
      this.assertCoordinates(nextLat, nextLng);
    }
    const meta =
      dto.geo || dto.lat !== undefined || dto.lng !== undefined
        ? await this.resolveGeoMeta(nextLat, nextLng, dto.geo)
        : null;

    await this.db.withTransaction(async (client) => {
      if (dto.photoKeys) {
        await this.uploads.assertUsableKeys(userId, dto.photoKeys, {
          client,
          allowSpotId: id,
        });
      }

      await client.query(
        `UPDATE spots SET
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           lat = $4,
           lng = $5,
           location = ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography,
           province = COALESCE($6, province),
           city = COALESCE($7, city),
           district = COALESCE($8, district),
           address = COALESCE($9, address),
           heading = COALESCE($10::spot_heading, heading),
           best_times = COALESCE($11::spot_best_time[], best_times),
           best_seasons = COALESCE($12::spot_season[], best_seasons),
           focal_length = COALESCE($13::spot_focal_length, focal_length),
           difficulty = COALESCE($14, difficulty),
           access_note = COALESCE($15, access_note),
           updated_at = now()
         WHERE id = $1`,
        [
          id,
          dto.title?.trim() ?? null,
          dto.description?.trim() ?? null,
          nextLat,
          nextLng,
          meta?.province ?? null,
          meta?.city ?? null,
          meta?.district ?? null,
          meta?.address ?? null,
          dto.heading ?? null,
          dto.bestTimes ?? null,
          dto.bestSeasons ?? null,
          dto.focalLength ?? null,
          dto.difficulty ?? null,
          dto.accessNote?.trim() || null,
        ],
      );

      if (dto.photoKeys) {
        await client.query('DELETE FROM photos WHERE spot_id = $1', [id]);
        await client.query(
          'UPDATE upload_tickets SET spot_id = NULL, used_at = NULL WHERE spot_id = $1',
          [id],
        );
        await this.attachPhotos(client, userId, id, dto.photoKeys);
      }
    });

    return this.findDetail(id, userId);
  }

  async softDelete(userId: string, id: string): Promise<{ id: string; deleted: true }> {
    const existing = await this.db.queryOne<{ user_id: string; status: string }>(
      'SELECT user_id, status FROM spots WHERE id = $1',
      [id],
    );
    if (!existing || existing.status === 'deleted') {
      throw AppException.notFound('该打卡点不存在或已被删除');
    }
    if (existing.user_id !== userId) {
      throw AppException.forbidden('只能删除自己创建的打卡点');
    }

    await this.db.query(
      `UPDATE spots SET status = 'deleted', updated_at = now() WHERE id = $1`,
      [id],
    );
    return { id, deleted: true };
  }

  /** 把票据对应的图片写成 photos 记录，并设置封面为第一张。 */
  private async attachPhotos(
    client: PoolClient,
    userId: string,
    spotId: string,
    keys: string[],
  ) {
    for (const [index, key] of keys.entries()) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO photos (spot_id, user_id, object_key, mime, size_bytes, width, height, sort_order)
         SELECT $1, $2, t.object_key, t.mime, t.size_bytes, t.width, t.height, $4
           FROM upload_tickets t
          WHERE t.object_key = $3
         RETURNING id`,
        [spotId, userId, key, index],
      );
      const photoId = rows[0]?.id;
      if (!photoId) throw AppException.badRequest('图片未完成上传，请重新上传后再提交');

      await client.query(
        `UPDATE upload_tickets SET spot_id = $2, used_at = now() WHERE object_key = $1`,
        [key, spotId],
      );
      if (index === 0) {
        await client.query('UPDATE spots SET cover_photo_id = $2 WHERE id = $1', [spotId, photoId]);
      }
    }
  }

  private assertCoordinates(lat: number, lng: number) {
    if (!isInMainlandChina(lat, lng)) {
      throw AppException.badRequest('v1 只支持中国大陆范围内的打卡点');
    }
  }

  /** bbox 解析失败属于客户端参数问题，统一转成 400 而不是 500。 */
  private parseBboxOrBadRequest(raw: string): Bbox {
    try {
      return parseBbox(raw);
    } catch (error) {
      throw AppException.badRequest((error as Error).message);
    }
  }

  /** 优先使用前端选点时已经拿到的逆地理结果，缺失才回源高德（省配额）。 */
  private async resolveGeoMeta(
    lat: number,
    lng: number,
    provided?: GeoMetaDto,
  ): Promise<{ province: string | null; city: string | null; district: string | null; address: string | null }> {
    if (provided && (provided.city || provided.address || provided.province)) {
      return {
        province: provided.province ?? null,
        city: provided.city ?? null,
        district: provided.district ?? null,
        address: provided.address ?? null,
      };
    }
    const meta = await this.geo.reverse(lat, lng);
    return {
      province: meta.province,
      city: meta.city,
      district: meta.district,
      address: meta.address,
    };
  }

  private toSummary(row: SpotRow, viewer?: LatLng | null): SpotSummary {
    const bestTimes = toStringArray(row.best_times) as BestTime[];
    return {
      id: row.id,
      title: row.title,
      lat: Number(row.lat),
      lng: Number(row.lng),
      city: row.city,
      district: row.district,
      difficulty: row.difficulty,
      difficultyLabel: DIFFICULTY_LABELS[row.difficulty] ?? '未知',
      heading: row.heading,
      headingLabel: row.heading ? HEADING_LABELS[row.heading] : null,
      bestTimes,
      bestTimeLabels: bestTimes.map((item) => BEST_TIME_LABELS[item]),
      coverUrl: row.cover_key ? this.storage.publicUrl(row.cover_key) : null,
      distanceMeters: viewer
        ? Math.round(distanceInMeters(viewer, { lat: Number(row.lat), lng: Number(row.lng) }))
        : null,
      author: { nickname: row.nickname, avatarUrl: row.avatar_url },
      createdAt: row.created_at.toISOString(),
    };
  }

  /** 供测试与调试：把 bbox 转成 PostGIS 可用的 WKT。 */
  static bboxToWkt = bboxToWkt;
}

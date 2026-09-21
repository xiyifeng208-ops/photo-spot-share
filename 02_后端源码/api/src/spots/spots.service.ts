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
import { decodeFeedCursor, encodeFeedCursor } from '../common/utils/feed-cursor.util';
import { DatabaseService } from '../database/database.service';
import { GeoService } from '../geo/geo.service';
import { StorageService } from '../storage/storage.service';
import { UploadsService } from '../uploads/uploads.service';
import { ContentCheckService } from './content-check.service';
import { ContentCheckTasksService } from './content-check-tasks.service';
import type { CreateSpotDto, GeoMetaDto, UpdateSpotDto } from './dto/spot.dto';
import { cleanGeo, normalizeRegion, supplementGeo, type NormalizedGeo } from './region.util';

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
  difficulty: number | null;
  access_note: string | null;
  cover_photo_id: string | null;
  status: 'active' | 'pending' | 'hidden' | 'deleted';
  view_count: number;
  created_at: Date;
  created_at_cursor: string;
  favorite_count: number | string;
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
  /** active=已公开；pending=机审中（仅作者可见）；hidden=已隐藏 */
  status: 'active' | 'pending' | 'hidden' | 'deleted';
  title: string;
  lat: number;
  lng: number;
  province: string | null;
  city: string | null;
  district: string | null;
  difficulty: number | null;
  difficultyLabel: string;
  heading: Heading | null;
  headingLabel: string | null;
  bestTimes: BestTime[];
  bestTimeLabels: string[];
  coverUrl: string | null;
  distanceMeters: number | null;
  author: { nickname: string | null; avatarUrl: string | null };
  createdAt: string;
  /** Current number of unique user-to-spot favorite relationships. */
  favoriteCount: number;
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
  isFavorited: boolean;
}

export interface ClusterPoint {
  city: string;
  count: number;
  lat: number;
  lng: number;
}

const SPOT_FIELDS = `
         s.id, s.user_id, s.title, s.description, s.lat, s.lng,
         s.province, s.city, s.district, s.address,
         s.heading, s.best_times::text[] AS best_times,
         s.best_seasons::text[] AS best_seasons, s.focal_length,
         s.difficulty, s.access_note, s.cover_photo_id, s.status,
         s.view_count, s.created_at, s.updated_at,
         to_char(s.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
         COALESCE(fc.favorite_count, 0) AS favorite_count,
         u.nickname, u.avatar_url,
         cp.object_key AS cover_key`;
const SPOT_FROM = `
    FROM spots s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN photos cp ON cp.id = s.cover_photo_id
    LEFT JOIN (SELECT spot_id, count(*) AS favorite_count FROM spot_favorites GROUP BY spot_id) fc ON fc.spot_id = s.id
`;
const SPOT_SELECT = `SELECT ${SPOT_FIELDS} ${SPOT_FROM}`;

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
    private readonly contentCheckTasks: ContentCheckTasksService,
  ) {}

  /** Route reads must never increment views or expose an author's non-public works. */
  async findPublicByIds(ids: string[]): Promise<SpotSummary[]> {
    if (!ids.length) return [];
    const { rows } = await this.db.query<SpotRow>(
      `${SPOT_SELECT} WHERE s.status = 'active' AND s.id = ANY($1::uuid[])`,
      [[...new Set(ids)]],
    );
    return rows.map(row => this.toSummary(row));
  }

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
    // pending（机审中）和 hidden（已隐藏）都只对作者本人可见
    if (row.status !== 'active' && row.user_id !== viewerId) {
      throw AppException.notFound('该打卡点正在审核中');
    }

    const favorite = viewerId
      ? await this.db.queryOne<{ is_favorited: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM spot_favorites WHERE user_id = $1 AND spot_id = $2) AS is_favorited`,
        [viewerId, id],
      )
      : null;

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
      isFavorited: favorite?.is_favorited ?? false,
    };
  }

  /** 发现流：按城市筛选，游标分页，用于列表页。 */
  async findFeed(params: {
    city?: string;
    province?: string;
    district?: string;
    keyword?: string;
    bestTimes?: BestTime[];
    bestSeasons?: Season[];
    focalLengths?: FocalLength[];
    difficulties?: number[];
    cursor?: string;
    limitRaw?: string;
    viewerId?: string;
    viewer?: LatLng | null;
  }): Promise<{ items: SpotSummary[]; nextCursor: string | null }> {
    const limit = normalizeLimit(params.limitRaw, 20);
    // Escape LIKE metacharacters before adding our own substring wildcards.
    const keyword = params.keyword?.trim();
    const sort = keyword ? 'favorites' : 'latest';
    const cursor = decodeFeedCursor(params.cursor, sort);
    const pattern = keyword ? `%${keyword.replace(/[\\%_]/g, '\\$&')}%` : null;
    const cursorCondition = sort === 'favorites'
      ? '(COALESCE(fc.favorite_count, 0), s.created_at, s.id) < ($12::bigint, $2::timestamptz, $3::uuid)'
      : '(s.created_at, s.id) < ($2::timestamptz, $3::uuid)';
    const order = sort === 'favorites'
      ? 'COALESCE(fc.favorite_count, 0) DESC, s.created_at DESC, s.id DESC'
      : 's.created_at DESC, s.id DESC';

    const { rows } = await this.db.query<SpotRow>(
      `${SPOT_SELECT}
        WHERE s.status = 'active'
          AND ($1::text IS NULL OR s.city = $1)
          AND ($5::text IS NULL OR s.province = $5)
          AND ($6::text IS NULL OR s.district = $6)
          AND ($7::text IS NULL OR (
            s.title ILIKE $7 OR s.province ILIKE $7 OR s.city ILIKE $7
            OR s.district ILIKE $7 OR s.address ILIKE $7
          ))
          AND ($8::spot_best_time[] IS NULL OR s.best_times && $8::spot_best_time[])
          AND ($9::spot_season[] IS NULL OR s.best_seasons && $9::spot_season[])
          AND ($10::spot_focal_length[] IS NULL OR s.focal_length = ANY($10::spot_focal_length[]))
          AND ($11::smallint[] IS NULL OR s.difficulty = ANY($11::smallint[]))
          AND (
            $2::timestamptz IS NULL
            OR ${cursorCondition}
          )
        ORDER BY ${order}
        LIMIT $4`,
      [params.city?.trim() || null, cursor?.createdAt ?? null, cursor?.id ?? null, limit,
        params.province?.trim() || null, params.district?.trim() || null, pattern,
        params.bestTimes?.length ? params.bestTimes : null,
        params.bestSeasons?.length ? params.bestSeasons : null,
        params.focalLengths?.length ? params.focalLengths : null,
        params.difficulties?.length ? params.difficulties : null,
        ...(sort === 'favorites' ? [cursor?.favoriteCount ?? null] : [])],
    );

    const last = rows.at(-1);
    return {
      items: rows.map((row) => this.toSummary(row, params.viewer)),
      nextCursor:
        rows.length >= limit && last
          ? encodeFeedCursor({ createdAt: last.created_at_cursor ?? last.created_at.toISOString(), id: last.id,
            favoriteCount: Number(last.favorite_count ?? 0) }, sort)
          : null,
    };
  }

  /** 公开作品可收藏；重复操作不更新收藏时间，避免清单排序跳动。 */
  async addFavorite(userId: string, spotId: string): Promise<{ isFavorited: true; favoriteCount: number }> {
    return this.db.withTransaction(async client => {
      // 共享行锁使同时下线/删除与收藏操作按事务顺序生效。
      const spot = await client.query<{ id: string }>(
        `SELECT id FROM spots WHERE id = $1 AND status = 'active' FOR SHARE`,
        [spotId],
      );
      if (!spot.rows.length) throw AppException.notFound('该作品不存在或暂不可收藏');
      await client.query(
        `INSERT INTO spot_favorites (user_id, spot_id) VALUES ($1, $2)
         ON CONFLICT (user_id, spot_id) DO NOTHING`,
        [userId, spotId],
      );
      return { isFavorited: true as const, favoriteCount: await this.countFavorites(client, spotId, userId) };
    });
  }

  /** 下线作品也允许移出；不返回作品内容，不向非作者泄露非公开计数。 */
  async removeFavorite(userId: string, spotId: string): Promise<{ isFavorited: false; favoriteCount: number }> {
    return this.db.withTransaction(async client => {
      await client.query('DELETE FROM spot_favorites WHERE user_id = $1 AND spot_id = $2', [userId, spotId]);
      return { isFavorited: false as const, favoriteCount: await this.countFavorites(client, spotId, userId) };
    });
  }

  private async countFavorites(client: PoolClient, spotId: string, viewerId: string): Promise<number> {
    const result = await client.query<{ favorite_count: string }>(
      `SELECT count(*) AS favorite_count FROM spot_favorites f JOIN spots s ON s.id=f.spot_id
       WHERE f.spot_id=$1 AND (s.status='active' OR (s.user_id=$2 AND s.status IN ('hidden','pending')))`,
      [spotId, viewerId]);
    return Number(result.rows[0]?.favorite_count ?? 0);
  }

  async findFavorites(userId: string, params: {
    province?: string;
    city?: string;
    district?: string;
    cursor?: string;
    limitRaw?: string;
    viewer?: LatLng | null;
  } = {}): Promise<{ items: SpotSummary[]; nextCursor: string | null }> {
    const limit = normalizeLimit(params.limitRaw, 20);
    const cursor = decodeCursor(params.cursor);
    const { rows } = await this.db.query<SpotRow & { favorited_at: Date }>(
      `SELECT ${SPOT_FIELDS}, f.created_at AS favorited_at
       ${SPOT_FROM}
       JOIN spot_favorites f ON f.spot_id = s.id
       WHERE f.user_id = $1 AND s.status = 'active'
         AND ($2::text IS NULL OR s.province = $2)
         AND ($3::text IS NULL OR s.city = $3)
         AND ($4::text IS NULL OR s.district = $4)
         AND ($5::timestamptz IS NULL OR (f.created_at, f.spot_id) < ($5::timestamptz, $6::uuid))
       ORDER BY f.created_at DESC, f.spot_id DESC
       LIMIT $7`,
      [userId, params.province?.trim() || null, params.city?.trim() || null,
        params.district?.trim() || null, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
    );
    const last = rows.at(-1);
    return {
      items: rows.map(row => this.toSummary(row, params.viewer)),
      nextCursor: rows.length >= limit && last
        ? encodeCursor({ createdAt: last.favorited_at.toISOString(), id: last.id })
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
          ? encodeCursor({ createdAt: last.created_at_cursor ?? last.created_at.toISOString(), id: last.id })
          : null,
    };
  }

  async create(user: { id: string; openid: string }, dto: CreateSpotDto): Promise<SpotDetail> {
    const userId = user.id;
    this.assertCoordinates(dto.lat, dto.lng);
    const meta = await this.resolveGeoMeta(dto.lat, dto.lng, dto.geo);
    // 文本机审要用真实 openid（微信接口要求），不能用数据库里的用户 id
    const audit = await this.contentCheck.checkText(
      user.openid,
      `${dto.title} ${dto.description ?? ''} ${dto.accessNote ?? ''}`,
    );
    const textStatus: 'active' | 'hidden' = audit.pass ? 'active' : 'hidden';

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
          dto.difficulty ?? null,
          dto.accessNote?.trim() || null,
          textStatus,
        ],
      );
      const id = rows[0].id;
      await this.attachPhotos(client, userId, id, dto.photoKeys);
      return id;
    });

    // 文本通过后再送图片机审：提交成功就把机位挂在 pending，等回调转正
    if (textStatus === 'active') {
      const waiting = await this.contentCheckTasks.submitForSpot({
        spotId,
        openid: user.openid,
        photoKeys: dto.photoKeys,
      });
      if (waiting) {
        await this.db.query(
          `UPDATE spots SET status = 'pending', updated_at = now() WHERE id = $1`,
          [spotId],
        );
      }
    }

    return this.findDetail(spotId, userId);
  }

  async update(userId: string, id: string, dto: UpdateSpotDto): Promise<SpotDetail> {
    const existing = await this.db.queryOne<SpotRow>(
      'SELECT id, user_id, lat, lng, status, province, city, district, address FROM spots WHERE id = $1',
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
    const coordinatesChanged = nextLat !== Number(existing.lat) || nextLng !== Number(existing.lng);
    const meta = dto.geo !== undefined || coordinatesChanged
      ? await this.resolveGeoMeta(nextLat, nextLng,
        this.mergeGeoUpdate(existing, dto.geo, coordinatesChanged))
      : null;

    await this.db.withTransaction(async (client) => {
      if (dto.photoKeys) {
        await this.uploads.assertUsableKeys(userId, dto.photoKeys, {
          client,
          allowSpotId: id,
        });
      }

      // Only fixed, internal column/cast names enter SQL. Omitted values are not written;
      // explicit null and [] are parameters, not COALESCE fallbacks to the old value.
      const fields: string[] = [];
      const values: unknown[] = [id];
      const set = (column: string, value: unknown, cast = '') => {
        values.push(value);
        fields.push(`${column} = $${values.length}${cast}`);
      };
      if (dto.title !== undefined) set('title', dto.title.trim());
      if (dto.description !== undefined) set('description', dto.description.trim());
      if (coordinatesChanged) {
        set('lat', nextLat);
        const latIndex = values.length;
        set('lng', nextLng);
        fields.push(`location = ST_SetSRID(ST_MakePoint($${values.length}, $${latIndex}), 4326)::geography`);
      }
      if (meta) {
        set('province', meta.province);
        set('city', meta.city);
        set('district', meta.district);
        set('address', meta.address);
      }
      if (dto.heading !== undefined) set('heading', dto.heading, '::spot_heading');
      if (dto.bestTimes !== undefined) set('best_times', dto.bestTimes, '::spot_best_time[]');
      if (dto.bestSeasons !== undefined) set('best_seasons', dto.bestSeasons, '::spot_season[]');
      if (dto.focalLength !== undefined) set('focal_length', dto.focalLength, '::spot_focal_length');
      if (dto.difficulty !== undefined) set('difficulty', dto.difficulty, '::smallint');
      if (dto.accessNote !== undefined) set('access_note', dto.accessNote?.trim() || null);
      if (fields.length || dto.photoKeys !== undefined) {
        fields.push('updated_at = now()');
        await client.query(`UPDATE spots SET ${fields.join(', ')} WHERE id = $1`, values);
      }

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

  private mergeGeoUpdate(existing: SpotRow, provided: GeoMetaDto | undefined, moved: boolean): GeoMetaDto {
    if (moved) return provided ?? {};
    let base: GeoMetaDto = cleanGeo(existing);
    if (provided?.province !== undefined && provided.province?.trim() !== base.province) {
      base = { province: provided.province, city: null, district: null, address: null };
    }
    if (provided?.city !== undefined && provided.city?.trim() !== base.city) {
      base = { province: base.province, city: provided.city, district: null, address: null };
    }
    if (provided?.district !== undefined && provided.district?.trim() !== base.district) {
      base = { ...base, district: provided.district, address: null };
    }
    return { ...base, ...provided };
  }

  /** Complete manual regions work offline; failed reverse lookup is not a reason to guess. */
  private async resolveGeoMeta(
    lat: number,
    lng: number,
    provided?: GeoMetaDto,
  ): Promise<NormalizedGeo> {
    const manual = cleanGeo(provided);
    let normalized = normalizeRegion(manual);
    if (normalized?.address) return normalized;
    try {
      const reverse = await this.geo.reverse(lat, lng);
      normalized = normalizeRegion(supplementGeo(normalized ?? manual, reverse)) ?? normalized;
    } catch {
      // Keep user-entered text and return actionable validation instead of an upstream 502.
      this.logger.warn('地址补全不可用，继续校验用户确认的地区');
    }
    if (!normalized) throw AppException.badRequest('请手动确认完整的省份与城市（省直辖地区请选择对应地区）');
    return normalized;
  }

  private toSummary(row: SpotRow, viewer?: LatLng | null): SpotSummary {
    const bestTimes = toStringArray(row.best_times) as BestTime[];
    return {
      id: row.id,
      status: row.status,
      title: row.title,
      lat: Number(row.lat),
      lng: Number(row.lng),
      province: row.province,
      city: row.city,
      district: row.district,
      difficulty: row.difficulty,
      difficultyLabel: row.difficulty == null ? '暂不确定' : DIFFICULTY_LABELS[row.difficulty] ?? '暂不确定',
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
      favoriteCount: Number(row.favorite_count ?? 0),
    };
  }

  /** 供测试与调试：把 bbox 转成 PostGIS 可用的 WKT。 */
  static bboxToWkt = bboxToWkt;
}

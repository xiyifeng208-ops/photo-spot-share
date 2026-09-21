import { Transform, Type } from 'class-transformer';
import { REPORT_REASONS } from '../moderation.service';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import {
  BEST_TIMES,
  FOCAL_LENGTHS,
  HEADINGS,
  SEASONS,
  type BestTime,
  type FocalLength,
  type Heading,
  type Season,
} from '../../common/enums';
import { MAX_PHOTOS_PER_SPOT } from '../../storage/storage.types';

export class GeoMetaDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  province?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  city?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  district?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  address?: string | null;
}

export class CreateSpotDto {
  @IsString()
  @MinLength(2, { message: '标题至少 2 个字' })
  @MaxLength(40, { message: '标题最多 40 个字' })
  title!: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(1000, { message: '拍摄介绍最多 1000 个字' })
  description?: string;

  /** GCJ-02 纬度 */
  @IsNumber({}, { message: '纬度必须是数字' })
  @Min(-90)
  @Max(90)
  lat!: number;

  /** GCJ-02 经度 */
  @IsNumber({}, { message: '经度必须是数字' })
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @IsIn(HEADINGS, { message: '机位朝向取值不合法' })
  heading?: Heading | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(BEST_TIMES.length)
  @IsIn(BEST_TIMES, { each: true, message: '推荐时段取值不合法' })
  bestTimes?: BestTime[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(SEASONS.length)
  @IsIn(SEASONS, { each: true, message: '推荐季节取值不合法' })
  bestSeasons?: Season[];

  @IsOptional()
  @IsIn(FOCAL_LENGTHS, { message: '推荐焦段取值不合法' })
  focalLength?: FocalLength | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3, { message: '难度取值为 1-3' })
  difficulty?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(300, { message: '到达提示最多 300 个字' })
  accessNote?: string | null;

  @IsArray()
  // 注意：数组必须用 ArrayMinSize；MinLength 是字符串校验器，对数组一律判为不通过
  @ArrayMinSize(1, { message: '至少上传 1 张样张' })
  @ArrayMaxSize(MAX_PHOTOS_PER_SPOT, { message: '每个打卡点最多 9 张样张' })
  @IsString({ each: true })
  photoKeys!: string[];

  /** 选点时逆地理编码结果，缺省时由服务端补一次高德调用。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GeoMetaDto)
  geo?: GeoMetaDto;
}

export class UpdateSpotDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(2)
  @MaxLength(40)
  title?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @IsIn(HEADINGS)
  heading?: Heading | null;

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(BEST_TIMES.length)
  @IsIn(BEST_TIMES, { each: true })
  bestTimes?: BestTime[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(SEASONS.length)
  @IsIn(SEASONS, { each: true })
  bestSeasons?: Season[];

  @IsOptional()
  @IsIn(FOCAL_LENGTHS)
  focalLength?: FocalLength | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  difficulty?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  accessNote?: string | null;

  /** 传了就整体替换：需要保留的旧图 key 也要带上。 */
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMinSize(1, { message: '至少保留 1 张样张' })
  @ArrayMaxSize(MAX_PHOTOS_PER_SPOT)
  @IsString({ each: true })
  photoKeys?: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => GeoMetaDto)
  geo?: GeoMetaDto;
}

export class ListSpotsQueryDto {
  @IsString({ message: '缺少 bbox 参数' })
  bbox!: string;

  @IsOptional()
  @IsString()
  zoom?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}

export class ListFeedQueryDto {
  @IsOptional()
  @Transform(({ value }) => parseFilterCsv(value))
  @IsArray()
  @ArrayMaxSize(BEST_TIMES.length)
  @IsIn(BEST_TIMES, { each: true, message: '推荐时段筛选取值不合法' })
  bestTimes?: BestTime[];

  @IsOptional()
  @Transform(({ value }) => parseFilterCsv(value))
  @IsArray()
  @ArrayMaxSize(SEASONS.length)
  @IsIn(SEASONS, { each: true, message: '推荐季节筛选取值不合法' })
  bestSeasons?: Season[];

  @IsOptional()
  @Transform(({ value }) => parseFilterCsv(value))
  @IsArray()
  @ArrayMaxSize(FOCAL_LENGTHS.length)
  @IsIn(FOCAL_LENGTHS, { each: true, message: '推荐焦段筛选取值不合法' })
  focalLengths?: FocalLength[];

  @IsOptional()
  @Transform(({ value }) => parseFilterCsv(value, true))
  @IsArray()
  @ArrayMaxSize(3)
  @IsIn([1, 2, 3], { each: true, message: '到达难度筛选取值为 1-3' })
  difficulties?: number[];

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(100, { message: '搜索词最多 100 个字' })
  keyword?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  city?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}

/** 只接受单个逗号分隔字符串，重复 query 参数/对象不能绕过校验。 */
function parseFilterCsv(value: unknown, numeric = false): unknown {
  if (typeof value !== 'string' || value.length > 200) return { invalidCsv: true };
  if (!value.trim()) return [];
  const entries = value.split(',').map(item => item.trim());
  return [...new Set<string | number>(numeric
    ? entries.map(item => /^[1-3]$/.test(item) ? Number(item) : NaN)
    : entries)];
}

export class ListFavoritesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  district?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  limit?: string;
}

export class ReportSpotDto {
  @IsIn(REPORT_REASONS as unknown as string[], { message: '举报原因不合法' })
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '补充说明最多 200 个字' })
  detail?: string;
}

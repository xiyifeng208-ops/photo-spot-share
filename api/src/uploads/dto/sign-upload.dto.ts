import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ALLOWED_MIME_TYPES, MAX_PHOTO_BYTES, MAX_PHOTOS_PER_SPOT } from '../../storage/storage.types';

export class UploadItemDto {
  @IsIn(ALLOWED_MIME_TYPES, { message: '仅支持 jpg / png / webp 图片' })
  mime!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PHOTO_BYTES, { message: '单张图片不能超过 10MB' })
  size?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;
}

export class SignUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PHOTOS_PER_SPOT, { message: '每个打卡点最多 9 张样张' })
  @ValidateNested({ each: true })
  @Type(() => UploadItemDto)
  items!: UploadItemDto[];
}

export class RegisterLocalUploadDto {
  @IsString()
  key!: string;

  @IsOptional()
  @IsString()
  mime?: string;
}


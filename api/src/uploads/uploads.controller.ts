import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AppException } from '../common/errors';
import { RateLimit } from '../common/guards/rate-limit.guard';
import type { RequestUser } from '../common/guards/jwt-auth.guard';
import { RegisterLocalUploadDto, SignUploadDto } from './dto/sign-upload.dto';
import { UploadsService } from './uploads.service';

interface UploadedImage {
  buffer: Buffer;
  mimetype?: string;
  size: number;
}

@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploadsService: UploadsService) {}

  @Post('photos/sign')
  @RateLimit({ scope: 'user-and-route', limit: 30, windowMs: 60_000 })
  sign(@CurrentUser() user: RequestUser, @Body() dto: SignUploadDto) {
    return this.uploadsService.signUploads(user.id, dto.items);
  }

  /** 本地开发/离线演示用的上传端点；STORAGE_DRIVER=cos 时不可用。 */
  @Post('local')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @RateLimit({ scope: 'user-and-route', limit: 60, windowMs: 60_000 })
  async uploadLocal(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: UploadedImage | undefined,
    @Body() dto: RegisterLocalUploadDto,
  ) {
    if (!file) throw AppException.badRequest('缺少文件字段 file');
    if (!dto?.key) throw AppException.badRequest('缺少 key 字段');
    return this.uploadsService.recordLocalUpload({
      userId: user.id,
      key: dto.key,
      buffer: file.buffer,
      mime: dto.mime ?? file.mimetype,
    });
  }
}


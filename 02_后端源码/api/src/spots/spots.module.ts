import { Module } from '@nestjs/common';
import { GeoModule } from '../geo/geo.module';
import { UploadsModule } from '../uploads/uploads.module';
import { ContentCheckService } from './content-check.service';
import { ContentCheckTasksService } from './content-check-tasks.service';
import { ModerationService } from './moderation.service';
import { WechatCallbackController } from './wechat-callback.controller';
import { SpotsController } from './spots.controller';
import { SpotsService } from './spots.service';

@Module({
  imports: [GeoModule, UploadsModule],
  controllers: [SpotsController, WechatCallbackController],
  providers: [SpotsService, ContentCheckService, ContentCheckTasksService, ModerationService],
  // AdminController 在 AppModule 里，依赖这里的服务，必须导出
  exports: [SpotsService, ContentCheckTasksService, ModerationService],
})
export class SpotsModule {}

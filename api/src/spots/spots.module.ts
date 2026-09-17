import { Module } from '@nestjs/common';
import { GeoModule } from '../geo/geo.module';
import { UploadsModule } from '../uploads/uploads.module';
import { ContentCheckService } from './content-check.service';
import { SpotsController } from './spots.controller';
import { SpotsService } from './spots.service';

@Module({
  imports: [GeoModule, UploadsModule],
  controllers: [SpotsController],
  providers: [SpotsService, ContentCheckService],
  exports: [SpotsService],
})
export class SpotsModule {}


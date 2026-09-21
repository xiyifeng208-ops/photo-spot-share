import { Module } from '@nestjs/common';
import { SpotsModule } from '../spots/spots.module';
import { CURATED_ROUTES, ROUTE_CATALOG } from './routes.catalog';
import { RoutesController } from './routes.controller';
import { RoutesService } from './routes.service';

@Module({
  imports: [SpotsModule],
  controllers: [RoutesController],
  providers: [RoutesService, { provide: CURATED_ROUTES, useValue: ROUTE_CATALOG }],
})
export class RoutesModule {}

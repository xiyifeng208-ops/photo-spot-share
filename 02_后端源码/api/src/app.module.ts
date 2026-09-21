import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { AppConfigModule } from './config/app-config.module';
import { DatabaseModule } from './database/database.module';
import { StorageModule } from './storage/storage.module';
import { AuthModule } from './auth/auth.module';
import { GeoModule } from './geo/geo.module';
import { UploadsModule } from './uploads/uploads.module';
import { SpotsModule } from './spots/spots.module';
import { RoutesModule } from './routes/routes.module';
import { SpotConditionsModule } from './spot-conditions/spot-conditions.module';
import { ShootingTimesModule } from './shooting-times/shooting-times.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { HealthController } from './health.controller';
import { OrphanCleanupService } from './tasks/orphan-cleanup.service';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { AdminController } from './admin/admin.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    AppConfigModule,
    ScheduleModule.forRoot(),
    DatabaseModule,
    StorageModule,
    AuthModule,
    GeoModule,
    UploadsModule,
    SpotsModule,
    RoutesModule,
    SpotConditionsModule,
    ShootingTimesModule,
  ],
  controllers: [HealthController, AdminController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    OrphanCleanupService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}

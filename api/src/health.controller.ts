import { Controller, Get, Inject } from '@nestjs/common';
import { Public } from './common/guards/jwt-auth.guard';
import { DatabaseService } from './database/database.service';
import { StorageService } from './storage/storage.service';
import { APP_CONFIG } from './config/configuration';
import type { AppConfig } from './config/configuration';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
    private readonly storage: StorageService,
  ) {}

  @Public()
  @Get()
  async check() {
    let database = 'down';
    try {
      await this.db.query('SELECT 1');
      database = 'up';
    } catch {
      database = 'down';
    }

    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      storageDriver: this.storage.kind,
      env: this.config.nodeEnv,
      time: new Date().toISOString(),
    };
  }
}


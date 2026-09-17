import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './configuration';

/**
 * 全局配置模块：DatabaseModule / StorageModule 等全局模块都要注入 APP_CONFIG，
 * 因此配置本身必须由 @Global 模块导出，否则会出现 Nest 无法解析依赖的问题。
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}


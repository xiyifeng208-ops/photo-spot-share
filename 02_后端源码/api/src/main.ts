import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { loadConfig } from './config/configuration';

// 先加载 .env，保证 loadConfig() 在任何模块初始化之前就能读到配置
loadEnv({ path: ['.env.local', '.env'], quiet: true });

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.enableCors({ origin: true });

  // 本地存储驱动：把 var/uploads 挂到 /static，图片地址与 COS 驱动形态一致
  if (config.storage.driver === 'local') {
    app.useStaticAssets(resolve(process.cwd(), config.storage.localDir), { prefix: '/static/' });
  }

  app.enableShutdownHooks();
  await app.listen(config.port);

  const logger = new Logger('Bootstrap');
  logger.log(`API 已启动: http://localhost:${config.port}/api/v1`);
  logger.log(`图片存储驱动: ${config.storage.driver}`);
  if (!config.auth.devMode) {
    logger.log('开发登录已关闭（AUTH_DEV_MODE=false）');
  }
  if (!config.amap.key) {
    logger.warn('未配置 AMAP_KEY：逆地理编码将返回降级结果（创建流程仍可用）');
  }
}

bootstrap();

import { Logger } from '@nestjs/common';

// E2E fixtures may update/delete records. Reject accidental use of the daily DB.
if (process.env.TEST_DATABASE_URL) {
  const database = new URL(process.env.TEST_DATABASE_URL).pathname;
  if (!/^\/spot_test_[a-z0-9_]+$/.test(database)) {
    throw new Error('数据库测试仅允许 TEST_DATABASE_URL 指向 spot_test_* 独立库');
  }
}

// 单元测试里不需要 Nest 的启动日志，静音后失败信息更易读。
Logger.overrideLogger(false);

import { Logger } from '@nestjs/common';

// 单元测试里不需要 Nest 的启动日志，静音后失败信息更易读。
Logger.overrideLogger(false);

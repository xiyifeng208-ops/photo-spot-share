import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { WechatService } from './wechat.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenService, WechatService],
  exports: [TokenService, AuthService],
})
export class AuthModule {}


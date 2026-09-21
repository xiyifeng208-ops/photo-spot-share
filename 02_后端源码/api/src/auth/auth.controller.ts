import { Body, Controller, Get, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public, type RequestUser } from '../common/guards/jwt-auth.guard';
import { RateLimit } from '../common/guards/rate-limit.guard';
import { AuthService } from './auth.service';
import { WxLoginDto } from './dto/login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('wx-login')
  @RateLimit({ scope: 'ip', limit: 60, windowMs: 60_000 })
  login(@Body() dto: WxLoginDto) {
    return this.authService.loginWithCode(dto.code);
  }

  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.authService.getProfile(user.id);
  }

  @Patch('me')
  updateMe(@CurrentUser() user: RequestUser, @Body() dto: UpdateProfileDto) {
    return this.authService.updateProfile(user.id, dto);
  }
}


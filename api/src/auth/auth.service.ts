import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../common/errors';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';
import { DatabaseService } from '../database/database.service';
import { TokenService } from './token.service';
import { WechatService } from './wechat.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

export interface UserProfile {
  id: string;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  openid: string;
  nickname: string | null;
  avatar_url: string | null;
  created_at: Date;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
    private readonly wechat: WechatService,
    private readonly tokens: TokenService,
  ) {}

  async loginWithCode(code: string): Promise<{ token: string; user: UserProfile }> {
    const openid = await this.resolveOpenid(code);
    const user = await this.upsertUser(openid);
    return { token: this.tokens.sign(user.id, user.openid), user: toProfile(user) };
  }

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.db.queryOne<UserRow>(
      'SELECT id, openid, nickname, avatar_url, created_at FROM users WHERE id = $1',
      [userId],
    );
    if (!user) throw AppException.unauthorized();
    return toProfile(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<UserProfile> {
    const user = await this.db.queryOne<UserRow>(
      `UPDATE users
         SET nickname = COALESCE($2, nickname),
             avatar_url = COALESCE($3, avatar_url),
             updated_at = now()
       WHERE id = $1
       RETURNING id, openid, nickname, avatar_url, created_at`,
      [userId, dto.nickname?.trim() ?? null, dto.avatarUrl ?? null],
    );
    if (!user) throw AppException.unauthorized();
    return toProfile(user);
  }

  private async resolveOpenid(code: string): Promise<string> {
    const isDevCode = code.startsWith('dev:');

    if (isDevCode) {
      if (!this.config.auth.devMode) {
        throw AppException.unauthorized('当前环境不允许使用开发登录');
      }
      const deviceId = code.slice(4).trim();
      if (!deviceId) throw AppException.badRequest('开发登录缺少设备标识');
      return `dev:${deviceId}`;
    }

    const session = await this.wechat.code2Session(code);
    return session.openid;
  }

  private async upsertUser(openid: string): Promise<UserRow> {
    const user = await this.db.queryOne<UserRow>(
      `INSERT INTO users (openid)
       VALUES ($1)
       ON CONFLICT (openid) DO UPDATE SET updated_at = now()
       RETURNING id, openid, nickname, avatar_url, created_at`,
      [openid],
    );
    if (!user) throw new AppException('INTERNAL_ERROR', '创建用户失败', 500);
    return user;
  }
}

export function toProfile(user: UserRow): UserProfile {
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
    createdAt: user.created_at.toISOString(),
  };
}


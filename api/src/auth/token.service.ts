import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { APP_CONFIG } from '../config/configuration';
import type { AppConfig } from '../config/configuration';

export interface TokenPayload {
  sub: string;
  openid: string;
}

@Injectable()
export class TokenService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  sign(userId: string, openid: string): string {
    return jwt.sign({ sub: userId, openid }, this.config.auth.jwtSecret, {
      expiresIn: this.config.auth.jwtExpiresIn as jwt.SignOptions['expiresIn'],
    });
  }

  verify(token: string): TokenPayload | null {
    try {
      const decoded = jwt.verify(token, this.config.auth.jwtSecret);
      if (typeof decoded === 'string' || !decoded.sub) return null;
      return { sub: String(decoded.sub), openid: String((decoded as jwt.JwtPayload).openid ?? '') };
    } catch {
      return null;
    }
  }
}


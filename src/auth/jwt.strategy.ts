import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { readCookie } from './auth-cookie';
import { AuthService } from './auth.service';

export type AuthenticatedUser = { id: string; email: string; name: string; sessionId: string };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);
  constructor(config: ConfigService, private readonly auth: AuthService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request) => readCookie(request?.headers?.cookie, 'orfina_session') ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; sid?: string; email: string; name: string }): Promise<AuthenticatedUser | null> {
    if (!payload.sid || !(await this.auth.isSessionActive(payload.sid, payload.sub))) return null;
    return { id: payload.sub, email: payload.email, name: payload.name, sessionId: payload.sid };
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { SystemRole } from '@prisma/client';
import { cookieName, readCookie } from './auth-cookie';
import { AuthService } from './auth.service';
export type AuthenticatedUser = { id: string; email: string; name: string; sessionId: string; systemRole: SystemRole };
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private readonly auth: AuthService) {
    super({ jwtFromRequest: ExtractJwt.fromExtractors([
      (request) => readCookie(request?.headers?.cookie, cookieName('session')) ?? null, ExtractJwt.fromAuthHeaderAsBearerToken(),
    ]), ignoreExpiration: false, secretOrKey: config.getOrThrow<string>('JWT_SECRET'), algorithms: ['HS256'] });
  }
  async validate(payload: { sub: string; sid?: string }): Promise<AuthenticatedUser | null> {
    if (typeof payload.sid !== 'string' || typeof payload.sub !== 'string') return null;
    const session = await this.auth.activeSession(payload.sid, payload.sub);
    if (!session) return null;
    return { id: session.user.id, email: session.user.email, name: session.user.name,
      systemRole: session.user.systemRole, sessionId: session.id };
  }
}

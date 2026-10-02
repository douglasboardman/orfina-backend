import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { readCookie } from './auth-cookie';

export type AuthenticatedUser = { id: string; email: string; name: string };

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request) => readCookie(request?.headers?.cookie, 'orfina_session') ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: { sub: string; email: string; name: string }): AuthenticatedUser {
    this.logger.debug(`Sessão validada para o usuário ${payload.sub}.`);
    return { id: payload.sub, email: payload.email, name: payload.name };
  }
}

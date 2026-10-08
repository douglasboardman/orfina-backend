import { Controller, Get, Logger, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { GoogleIdentityService } from './google.strategy';
import { cookieName, readCookie, serializeCookie } from './auth-cookie';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser } from './jwt.strategy';
import { identityError } from '../identity/identity-policy';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  constructor(private readonly auth: AuthService, private readonly googleIdentity: GoogleIdentityService) {}
  @Get('google')
  google(@Res() reply: FastifyReply) {
    const flow = this.googleIdentity.authorization();
    reply.header('Set-Cookie', [serializeCookie(cookieName('oauth_state'), flow.state, 600),
      serializeCookie(cookieName('oauth_nonce'), flow.nonce, 600), serializeCookie(cookieName('oauth_verifier'), flow.verifier, 600)]);
    return reply.code(302).redirect(flow.url);
  }
  @Get('google/callback')
  async callback(@Req() req: FastifyRequest, @Query() query: { code?: string; state?: string }, @Res() reply: FastifyReply) {
    const clear = [cookieName('oauth_state'), cookieName('oauth_nonce'), cookieName('oauth_verifier')].map((name) => serializeCookie(name, '', 0));
    const expected = readCookie(req.headers.cookie, cookieName('oauth_state'));
    const nonce = readCookie(req.headers.cookie, cookieName('oauth_nonce'));
    const verifier = readCookie(req.headers.cookie, cookieName('oauth_verifier'));
    try {
      if (!expected || !query.state || query.state !== expected || !query.code || !nonce || !verifier) throw new Error('OAUTH_STATE_INVALID');
      const profile = await this.googleIdentity.exchange(query.code, verifier, nonce);
      const { token, refreshToken, csrf } = await this.auth.signInWithGoogle(profile);
      reply.header('Set-Cookie', [...clear, ...this.cookies(token, refreshToken, csrf)]);
      return reply.code(302).redirect(`${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/auth/callback`);
    } catch {
      this.logger.warn('identity.login-denied');
      reply.header('Set-Cookie', [...clear, ...this.cookies('', '', '', 0)]);
      return reply.code(302).redirect(`${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/acesso-restrito`);
    }
  }
  @Get('me') @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) { return { id: user.id, email: user.email, name: user.name, systemRole: user.systemRole }; }
  @Post('refresh')
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const refreshToken = readCookie(req.headers.cookie, cookieName('refresh'));
    const accessToken = readCookie(req.headers.cookie, cookieName('session'));
    const session = await this.auth.sessionFromRefreshToken(refreshToken) ?? await this.auth.sessionFromToken(accessToken);
    if (!session) identityError(401, 'SESSION_INVALID', 'Sessão inválida ou acesso restrito.');
    const { token, refreshToken: nextRefreshToken, csrf } = await this.auth.rotateSession(session.user, session.id);
    reply.header('Set-Cookie', this.cookies(token, nextRefreshToken, csrf));
    return { ok: true };
  }
  @Post('logout')
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.auth.sessionFromToken(readCookie(req.headers.cookie, cookieName('session')))
      ?? await this.auth.sessionFromRefreshToken(readCookie(req.headers.cookie, cookieName('refresh')));
    if (session) await this.auth.revokeSession(session.id, session.userId);
    reply.header('Set-Cookie', this.cookies('', '', '', 0));
    return { ok: true };
  }
  private cookies(token: string, refreshToken: string, csrf: string, accessMaxAge = 900) {
    const sessionMaxAge = accessMaxAge ? Number(process.env.SESSION_TTL_DAYS ?? 7) * 86400 : 0;
    return [
      serializeCookie(cookieName('session'), token, accessMaxAge),
      serializeCookie(cookieName('refresh'), refreshToken, sessionMaxAge, { path: '/api/auth' }),
      serializeCookie(cookieName('csrf'), csrf, sessionMaxAge, { httpOnly: false, path: '/' }),
      ...(process.env.NODE_ENV === 'production' ? [serializeCookie('orfina_session', '', 0), serializeCookie('orfina_refresh', '', 0), serializeCookie('orfina_csrf', '', 0, { httpOnly: false, path: '/' })] : []),
    ];
  }
}

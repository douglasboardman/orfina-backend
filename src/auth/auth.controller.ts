import { Controller, Get, Logger, Post, Redirect, Req, Res, UseGuards } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { User } from '@prisma/client';
import { GoogleAuthGuard } from './google-auth.guard';
import { createOAuthState, serializeCookie } from './auth-cookie';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { AuthenticatedUser } from './jwt.strategy';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly auth: AuthService) {}

  @Get('google')
  @UseGuards(GoogleAuthGuard)
  google() { /* passport redirects to Google */ }

  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  @Redirect()
  async callback(@Req() request: FastifyRequest, @Res({ passthrough: true }) response: { header(name: string, value: string | string[]): void }) {
    const user = (request as unknown as { user: User }).user;
    const { token } = await this.auth.createSession(user);
    response.header('Set-Cookie', [serializeCookie('orfina_session', token, 900), serializeCookie('orfina_csrf', createOAuthState(), 900, { httpOnly: false, path: '/' })]);
    const url = `${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/auth/callback`;
    this.logger.log(`Login Google concluído para o usuário ${user.id}.`);
    return { url, statusCode: 302 };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) { return user; }

  @Post('refresh')
  @UseGuards(JwtAuthGuard)
  async refresh(@CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: { header(name: string, value: string | string[]): void }) {
    const account = await this.auth.findUser(user.id);
    const { token } = await this.auth.rotateSession(account, user.sessionId);
    response.header('Set-Cookie', [serializeCookie('orfina_session', token, 900), serializeCookie('orfina_csrf', createOAuthState(), 900, { httpOnly: false, path: '/' })]);
    return { ok: true };
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: { header(name: string, value: string | string[]): void }) {
    await this.auth.revokeSession(user.sessionId, user.id);
    response.header('Set-Cookie', [serializeCookie('orfina_session', '', 0), serializeCookie('orfina_csrf', '', 0, { httpOnly: false, path: '/' })]);
    return { ok: true };
  }
}

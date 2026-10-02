import { Controller, Get, Logger, Post, Redirect, Req, Res, UseGuards } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { User } from '@prisma/client';
import { GoogleAuthGuard } from './google-auth.guard';
import { serializeCookie } from './auth-cookie';
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
  callback(@Req() request: FastifyRequest, @Res({ passthrough: true }) response: { header(name: string, value: string): void }) {
    const user = (request as unknown as { user: User }).user;
    const token = this.auth.createAccessToken(user);
    response.header('Set-Cookie', serializeCookie('orfina_session', token, 900));
    const url = `${process.env.FRONTEND_URL ?? 'http://localhost:4200'}/auth/callback`;
    this.logger.log(`Login Google concluído para o usuário ${user.id}.`);
    return { url, statusCode: 302 };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthenticatedUser) { return user; }

  @Post('logout')
  logout(@Res({ passthrough: true }) response: { header(name: string, value: string): void }) {
    response.header('Set-Cookie', serializeCookie('orfina_session', '', 0));
    return { ok: true };
  }
}

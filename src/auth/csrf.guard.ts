import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { cookieName, readCookie } from './auth-cookie';
import { AuthService, hashCsrf } from './auth.service';
import { identityError } from '../identity/identity-policy';
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ method: string; url: string; headers: { cookie?: string; origin?: string; authorization?: string; 'x-orfina-csrf'?: string } }>();
    if (!unsafeMethods.has(request.method)) return true;
    if (!request.headers.origin || !allowedOrigins().includes(request.headers.origin)) identityError(403, 'CSRF_INVALID', 'Origem não autorizada.');
    const route = request.url.split('?')[0];
    const accessToken = readCookie(request.headers.cookie, cookieName('session')) ?? request.headers.authorization?.replace(/^Bearer /, '');
    const session = await this.auth.sessionFromToken(accessToken)
      ?? (route === '/api/auth/refresh' ? await this.auth.sessionFromRefreshToken(readCookie(request.headers.cookie, cookieName('refresh'))) : null);
    if (!session && route === '/api/auth/logout') return true;
    if (!session) identityError(401, 'SESSION_INVALID', 'Sessão inválida ou acesso restrito.');
    const cookie = readCookie(request.headers.cookie, cookieName('csrf'));
    const header = request.headers['x-orfina-csrf'];
    if (!cookie || !header || cookie !== header || header.length > 256 || !session.csrfTokenHash) identityError(403, 'CSRF_INVALID', 'Proteção CSRF inválida.');
    const expected = Buffer.from(session.csrfTokenHash, 'hex');
    const actual = Buffer.from(hashCsrf(header), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) identityError(403, 'CSRF_INVALID', 'Proteção CSRF inválida.');
    return true;
  }
}
export const allowedOrigins = () => (process.env.FRONTEND_URLS ?? process.env.FRONTEND_URL ?? 'http://localhost:4200').split(',').map((origin) => origin.trim()).filter(Boolean);

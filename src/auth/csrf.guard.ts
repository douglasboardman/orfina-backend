import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { readCookie } from './auth-cookie';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cookie sessions need an explicit browser-bound proof for mutating requests.
 * The token is readable by the same-site Angular application and must match the
 * non-HttpOnly cookie; an attacker on another origin can send neither value.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ method: string; headers: { cookie?: string; origin?: string; 'x-orfina-csrf'?: string } }>();
    if (!unsafeMethods.has(request.method)) return true;
    const cookie = readCookie(request.headers.cookie, 'orfina_csrf');
    const header = request.headers['x-orfina-csrf'];
    if (!cookie || !header || cookie !== header) throw new ForbiddenException('Proteção CSRF inválida.');
    const origin = request.headers.origin;
    if (origin && !allowedOrigins().includes(origin)) throw new ForbiddenException('Origem não autorizada.');
    return true;
  }
}

export const allowedOrigins = () => (process.env.FRONTEND_URLS ?? process.env.FRONTEND_URL ?? 'http://localhost:4200')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

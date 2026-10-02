import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { readCookie } from './auth-cookie';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  handleRequest<TUser = unknown>(err: Error | null, user: TUser | false | null, info: { name?: string } | undefined, context: ExecutionContext): TUser {
    if (!user || err) {
      const request = context.switchToHttp().getRequest<{ url: string; headers: { cookie?: string } }>();
      this.logger.warn(`Sessão rejeitada em ${request.url}; cookie de sessão recebido: ${Boolean(readCookie(request.headers.cookie, 'orfina_session'))}; motivo: ${info?.name ?? err?.name ?? 'ausente'}.`);
    }
    return super.handleRequest(err, user, info, context) as TUser;
  }
}

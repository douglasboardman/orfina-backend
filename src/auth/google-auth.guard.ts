import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { createOAuthState, readCookie, serializeCookie } from './auth-cookie';

/**
 * Passport escreve cabeçalhos HTTP diretamente durante o redirecionamento OAuth.
 * O Fastify encapsula a resposta em FastifyReply, portanto o Passport deve receber
 * a resposta Node.js nativa exposta em `reply.raw`.
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ url: string; headers: { cookie?: string }; query: { state?: string } }>();
    if (request.url.includes('/callback')) {
      const expectedState = readCookie(request.headers.cookie, 'orfina_oauth_state');
      if (!expectedState || request.query.state !== expectedState) throw new UnauthorizedException('Estado OAuth inválido.');
    }
    return (await super.canActivate(context)) as boolean;
  }

  getAuthenticateOptions(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ url: string }>();
    if (request.url.includes('/callback')) return {};
    const response = context.switchToHttp().getResponse<{ raw: { setHeader(name: string, value: string): void } }>().raw;
    const state = createOAuthState();
    response.setHeader('Set-Cookie', serializeCookie('orfina_oauth_state', state, 600));
    return { state };
  }

  getResponse(context: ExecutionContext) {
    return context.switchToHttp().getResponse<{ raw: unknown }>().raw;
  }
}

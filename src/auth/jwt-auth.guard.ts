import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { identityError } from '../identity/identity-policy';
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = unknown>(err: Error | null, user: TUser | false | null): TUser {
    if (err) throw err;
    if (!user) identityError(401, 'SESSION_INVALID', 'Sessão inválida ou acesso restrito.');
    return user;
  }
}

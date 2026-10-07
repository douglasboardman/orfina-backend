import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { identityError } from './identity-policy';

@Injectable()
export class SystemAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ user?: { systemRole: string } }>();
    if (request.user?.systemRole !== 'SYSTEM_ADMIN') identityError(403, 'SYSTEM_ADMIN_REQUIRED', 'Permissão de administrador do sistema necessária.');
    return true;
  }
}

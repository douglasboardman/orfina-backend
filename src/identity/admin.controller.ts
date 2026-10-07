import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { AdminService } from './admin.service';
import { SystemAdminGuard } from './system-admin.guard';
import { emailSchema, reasonSchema } from './identity-policy';

const pagination = { page: z.coerce.number().int().min(1).max(100000).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) };
export const createGrantSchema = z.object({ email: emailSchema, reason: reasonSchema.optional() }).strict();
export const statusSchema = z.object({ status: z.enum(['ENABLED', 'DISABLED']), reason: reasonSchema.optional(), expectedVersion: z.number().int().positive() }).strict()
  .refine((value) => value.status !== 'DISABLED' || Boolean(value.reason), { path: ['reason'], message: 'Informe o motivo da desabilitação.' });
const listSchema = z.object({ ...pagination, search: z.string().trim().max(254).optional(), status: z.enum(['ENABLED', 'DISABLED']).optional(), linked: z.enum(['yes', 'no']).optional() }).strict();
const auditSchema = z.object({ ...pagination, action: z.string().max(80).optional(), actorUserId: z.string().max(100).optional(), targetId: z.string().max(100).optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional() }).strict().refine((q) => !q.from || !q.to || q.from <= q.to, 'Período inválido.');

@Controller('admin')
@UseGuards(JwtAuthGuard, SystemAdminGuard)
export class AdminController {
  constructor(private readonly admin: AdminService) {}
  @Get('access-grants') list(@Query() query: unknown) { return this.admin.list(listSchema.parse(query)); }
  @Post('access-grants') create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown, @Req() req: { id: string }) {
    return this.admin.create({ ...user, requestId: req.id }, createGrantSchema.parse(body));
  }
  @Get('access-grants/:id') detail(@Param('id') id: string) { return this.admin.detail(z.string().max(100).parse(id)); }
  @Patch('access-grants/:id/status') status(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown, @Req() req: { id: string }) {
    return this.admin.setStatus({ ...user, requestId: req.id }, id, statusSchema.parse(body));
  }
  @Post('users/:id/revoke-sessions') revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown, @Req() req: { id: string }) {
    return this.admin.revoke({ ...user, requestId: req.id }, id, z.object({ reason: reasonSchema }).strict().parse(body).reason);
  }
  @Get('audit-logs') audit(@Query() query: unknown) { return this.admin.audit(auditSchema.parse(query)); }
}

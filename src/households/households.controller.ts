import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { HouseholdRole } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { HouseholdsService } from './households.service';

const createHouseholdSchema = z.object({
  name: z.string().trim().min(2).max(80),
  currency: z.string().length(3).default('BRL'),
  timezone: z.string().min(1).default('America/Sao_Paulo'),
});
const createInvitationSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum([HouseholdRole.MEMBER, HouseholdRole.VIEWER]).default(HouseholdRole.MEMBER),
});

@Controller('households')
@UseGuards(JwtAuthGuard)
export class HouseholdsController {
  constructor(private readonly households: HouseholdsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.households.listForUser(user.id);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const dto = createHouseholdSchema.parse(body);
    return this.households.create(user.id, dto.name, dto.currency, dto.timezone);
  }

  @Get('invitations/mine')
  listMyInvitations(@CurrentUser() user: AuthenticatedUser) {
    return this.households.listMyPendingInvitations(user.id, user.email);
  }

  @Post('invitations/:invitationId/accept')
  acceptInvitation(@CurrentUser() user: AuthenticatedUser, @Param('invitationId') invitationId: string) {
    return this.households.acceptInvitation(user.id, user.email, invitationId);
  }

  @Get(':householdId/members')
  listMembers(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) {
    return this.households.listMembers(user.id, householdId);
  }

  @Get(':householdId/invitations')
  listInvitations(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) {
    return this.households.listInvitations(user.id, householdId);
  }

  @Post(':householdId/invitations')
  createInvitation(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) {
    const dto = createInvitationSchema.parse(body);
    return this.households.createInvitation(user.id, householdId, dto.email, dto.role);
  }

  @Patch(':householdId/invitations/:invitationId/revoke')
  revokeInvitation(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('invitationId') invitationId: string) {
    return this.households.revokeInvitation(user.id, householdId, invitationId);
  }
}

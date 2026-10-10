import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { FinancialRealizationMode, HouseholdRole, RecurringMaterializationMode } from '@prisma/client';
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
  role: z.enum([HouseholdRole.MANAGER, HouseholdRole.MEMBER, HouseholdRole.VIEWER]).default(HouseholdRole.MEMBER),
});
const updateMemberSchema = z.object({
  role: z.enum([HouseholdRole.MANAGER, HouseholdRole.MEMBER, HouseholdRole.VIEWER]),
  displayName: z.string().trim().min(2).max(80).optional().or(z.literal('')),
  isActive: z.boolean().default(true),
  archive: z.boolean().default(false),
});
const householdSettingsSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  recurringMaterializationMode: z.nativeEnum(RecurringMaterializationMode).optional(),
  recurringMaterializationValue: z.number().int().min(0).max(28).optional(),
  financialRealizationMode: z.nativeEnum(FinancialRealizationMode).optional(),
}).superRefine((data, context) => {
  if (!data.name && !data.recurringMaterializationMode && !data.financialRealizationMode && data.recurringMaterializationValue === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Informe ao menos uma configuração para atualizar.' });
  if (data.recurringMaterializationMode === RecurringMaterializationMode.EXERCISE_MONTH_DAY && (!data.recurringMaterializationValue || data.recurringMaterializationValue > 15)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['recurringMaterializationValue'], message: 'Informe um dia entre 1 e 15.' });
  if (data.recurringMaterializationMode === RecurringMaterializationMode.DAYS_BEFORE_EXERCISE_MONTH && (!data.recurringMaterializationValue || data.recurringMaterializationValue > 28)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['recurringMaterializationValue'], message: 'Informe entre 1 e 28 dias.' });
  if (data.recurringMaterializationMode === RecurringMaterializationMode.ON_OCCURRENCE_DATE && data.recurringMaterializationValue !== undefined && data.recurringMaterializationValue !== 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['recurringMaterializationValue'], message: 'O modo na data não usa valor adicional.' });
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

  @Patch(':householdId')
  updateSettings(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) {
    return this.households.updateSettings(user.id, householdId, householdSettingsSchema.parse(body));
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

  @Get(':householdId/archived-members')
  listArchivedMembers(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) {
    return this.households.listArchivedMembers(user.id, householdId);
  }

  @Get(':householdId/invitations')
  listInvitations(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) {
    return this.households.listInvitations(user.id, householdId);
  }

  @Patch(':householdId/members/:memberUserId')
  updateMember(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('memberUserId') memberUserId: string, @Body() body: unknown) {
    return this.households.updateMember(user.id, householdId, memberUserId, updateMemberSchema.parse(body));
  }

  @Delete(':householdId/members/:memberUserId')
  deleteArchivedMember(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('memberUserId') memberUserId: string) {
    return this.households.deleteArchivedMember(user.id, householdId, memberUserId);
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

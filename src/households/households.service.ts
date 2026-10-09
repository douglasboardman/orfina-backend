import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { FinancialRealizationMode, HouseholdInvitationStatus, HouseholdRole, RecurringMaterializationMode } from '@prisma/client';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class HouseholdsService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventsService) {}

  listForUser(userId: string) {
    return this.prisma.household.findMany({
      where: { members: { some: { userId, isActive: true, archivedAt: null } } },
      include: { members: { where: { userId, isActive: true, archivedAt: null }, select: { role: true, displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(userId: string, name: string, currency: string, timezone: string) {
    return this.prisma.$transaction(async (tx) => {
      const household = await tx.household.create({
        data: { name, currency, timezone, members: { create: { userId, role: HouseholdRole.OWNER } } },
      });
      await this.events.record(tx, {
        aggregateType: 'household', aggregateId: household.id,
        eventType: 'orfina.households.household-created.v1',
        payload: { householdId: household.id, ownerId: userId, name },
      });
      return household;
    });
  }

  async rename(userId: string, householdId: string, name: string) {
    await this.assertCanManage(userId, householdId);
    return this.prisma.$transaction(async (tx) => {
      const household = await tx.household.update({
        where: { id: householdId },
        data: { name },
        include: { members: { where: { userId }, select: { role: true } } },
      });
      await this.events.record(tx, {
        aggregateType: 'household', aggregateId: householdId,
        eventType: 'orfina.households.household-renamed.v1',
        payload: { householdId, name },
      });
      return household;
    });
  }

  async updateSettings(userId: string, householdId: string, settings: { name?: string; recurringMaterializationMode?: RecurringMaterializationMode; recurringMaterializationValue?: number; financialRealizationMode?: FinancialRealizationMode }) {
    if (settings.name && Object.keys(settings).length === 1) return this.rename(userId, householdId, settings.name);
    await this.assertCanManage(userId, householdId);
    const current = await this.prisma.household.findUnique({ where: { id: householdId } });
    if (!current) throw new ForbiddenException('Grupo familiar não encontrado.');
    const mode = settings.recurringMaterializationMode ?? current.recurringMaterializationMode;
    const value = settings.recurringMaterializationValue ?? current.recurringMaterializationValue;
    if ((mode === RecurringMaterializationMode.EXERCISE_MONTH_DAY && (value < 1 || value > 15)) || (mode === RecurringMaterializationMode.DAYS_BEFORE_EXERCISE_MONTH && (value < 1 || value > 28)) || (mode === RecurringMaterializationMode.ON_OCCURRENCE_DATE && value !== 0)) throw new ForbiddenException('Configuração de geração de recorrências inválida.');
    return this.prisma.$transaction(async (tx) => {
      const household = await tx.household.update({ where: { id: householdId }, data: { ...settings, recurringMaterializationValue: mode === RecurringMaterializationMode.ON_OCCURRENCE_DATE ? 0 : value }, include: { members: { where: { userId }, select: { role: true } } } });
      await this.events.record(tx, { aggregateType: 'household', aggregateId: householdId, eventType: 'orfina.households.financial-settings-updated.v1', payload: { householdId, recurringMaterializationMode: household.recurringMaterializationMode, recurringMaterializationValue: household.recurringMaterializationValue, financialRealizationMode: household.financialRealizationMode } });
      await tx.auditLog.create({ data: { householdId, actorId: userId, aggregateType: 'household', aggregateId: householdId, action: 'settings-updated', changedFields: Object.keys(settings) } });
      return household;
    });
  }

  async assertMember(userId: string, householdId: string) {
    const member = await this.prisma.householdMember.findUnique({ where: { householdId_userId: { householdId, userId } } });
    if (!member) throw new ForbiddenException('Você não tem acesso a este grupo familiar.');
    if (member.isActive === false || member.archivedAt) throw new ForbiddenException('Seu acesso a este grupo familiar está inativo ou arquivado.');
    return member;
  }

  async assertCanWrite(userId: string, householdId: string) {
    const member = await this.assertMember(userId, householdId);
    if (member.role === HouseholdRole.VIEWER) throw new ForbiddenException('Seu perfil neste grupo é somente leitura.');
    return member;
  }

  async assertCanManage(userId: string, householdId: string) {
    const member = await this.assertMember(userId, householdId);
    if (member.role !== HouseholdRole.OWNER && member.role !== HouseholdRole.ADMIN && member.role !== HouseholdRole.MANAGER) {
      throw new ForbiddenException('Seu perfil não pode administrar este grupo familiar.');
    }
    return member;
  }

  async assertCanManageUsers(userId: string, householdId: string) {
    const member = await this.assertMember(userId, householdId);
    if (member.role !== HouseholdRole.OWNER && member.role !== HouseholdRole.ADMIN) {
      throw new ForbiddenException('Seu perfil não pode administrar os usuários deste grupo familiar.');
    }
    return member;
  }

  async listMembers(userId: string, householdId: string) {
    await this.assertCanManageUsers(userId, householdId);
    return this.prisma.householdMember.findMany({
      where: { householdId },
      include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async updateMember(actorId: string, householdId: string, memberUserId: string, input: { role: HouseholdRole; displayName?: string; isActive: boolean; archive: boolean }) {
    await this.assertCanManageUsers(actorId, householdId);
    const target = await this.prisma.householdMember.findUnique({ where: { householdId_userId: { householdId, userId: memberUserId } } });
    if (!target) throw new NotFoundException('Membro não encontrado neste grupo familiar.');
    if (target.role === HouseholdRole.OWNER || target.role === HouseholdRole.ADMIN) throw new BadRequestException('O papel deste membro é protegido e não pode ser alterado por esta operação.');
    return this.prisma.$transaction(async (tx) => {
      const member = await tx.householdMember.update({
        where: { householdId_userId: { householdId, userId: memberUserId } },
        data: { role: input.role, displayName: input.displayName || null, isActive: input.archive ? false : input.isActive, archivedAt: input.archive ? new Date() : null },
        include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
      });
      await this.events.record(tx, {
        aggregateType: 'household-member', aggregateId: `${householdId}:${memberUserId}`,
        eventType: 'orfina.households.member-role-updated.v1',
        payload: { householdId, memberUserId, role: input.role, isActive: input.archive ? false : input.isActive, archived: input.archive, actorId },
      });
      await tx.auditLog.create({ data: { householdId, actorId, aggregateType: 'household-member', aggregateId: `${householdId}:${memberUserId}`, action: 'member-updated', changedFields: ['role', 'displayName', 'isActive', 'archivedAt'] } });
      return member;
    });
  }

  async listInvitations(userId: string, householdId: string) {
    await this.assertCanManageUsers(userId, householdId);
    return this.prisma.householdInvitation.findMany({
      where: { householdId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createInvitation(userId: string, householdId: string, email: string, role: HouseholdRole) {
    await this.assertCanManageUsers(userId, householdId);
    if (role === HouseholdRole.OWNER || role === HouseholdRole.ADMIN) {
      throw new BadRequestException('Convites não podem atribuir os papéis OWNER ou ADMIN.');
    }
    const normalizedEmail = email.trim().toLowerCase();
    const invitedUser = await this.prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
    if (invitedUser) {
      const existingMember = await this.prisma.householdMember.findUnique({ where: { householdId_userId: { householdId, userId: invitedUser.id } } });
      if (existingMember) throw new BadRequestException('Este usuário já pertence ao grupo familiar.');
    }
    const pending = await this.prisma.householdInvitation.findFirst({ where: { householdId, email: normalizedEmail, status: HouseholdInvitationStatus.PENDING } });
    if (pending) throw new BadRequestException('Já existe um convite pendente para este e-mail.');

    return this.prisma.$transaction(async (tx) => {
      const invitation = await tx.householdInvitation.create({
        data: {
          householdId,
          email: normalizedEmail,
          role,
          invitedById: userId,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      await this.events.record(tx, {
        aggregateType: 'household-invitation', aggregateId: invitation.id,
        eventType: 'orfina.households.invitation-created.v1',
        payload: { invitationId: invitation.id, householdId, email: normalizedEmail, role, expiresAt: invitation.expiresAt.toISOString() },
      });
      return invitation;
    });
  }

  async revokeInvitation(userId: string, householdId: string, invitationId: string) {
    await this.assertCanManageUsers(userId, householdId);
    const invitation = await this.prisma.householdInvitation.findFirst({ where: { id: invitationId, householdId } });
    if (!invitation) throw new NotFoundException('Convite não encontrado neste grupo familiar.');
    if (invitation.status !== HouseholdInvitationStatus.PENDING) throw new BadRequestException('Somente convites pendentes podem ser revogados.');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.householdInvitation.update({ where: { id: invitationId }, data: { status: HouseholdInvitationStatus.REVOKED } });
      await this.events.record(tx, {
        aggregateType: 'household-invitation', aggregateId: invitationId,
        eventType: 'orfina.households.invitation-revoked.v1',
        payload: { invitationId, householdId },
      });
      return updated;
    });
  }

  async listMyPendingInvitations(userId: string, email: string) {
    await this.expireOutstandingInvitations(email);
    return this.prisma.householdInvitation.findMany({
      where: { email: email.toLowerCase(), status: HouseholdInvitationStatus.PENDING },
      include: { household: { select: { id: true, name: true, currency: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async acceptInvitation(userId: string, email: string, invitationId: string) {
    const invitation = await this.prisma.householdInvitation.findFirst({
      where: { id: invitationId, email: email.toLowerCase() },
    });
    if (!invitation) throw new NotFoundException('Convite não encontrado para esta conta.');
    if (invitation.status !== HouseholdInvitationStatus.PENDING) throw new BadRequestException('Este convite não está mais disponível.');
    if (invitation.expiresAt <= new Date()) {
      await this.prisma.householdInvitation.update({ where: { id: invitationId }, data: { status: HouseholdInvitationStatus.EXPIRED } });
      throw new BadRequestException('Este convite expirou.');
    }

    return this.prisma.$transaction(async (tx) => {
      const existingMember = await tx.householdMember.findUnique({ where: { householdId_userId: { householdId: invitation.householdId, userId } } });
      if (!existingMember) await tx.householdMember.create({ data: { householdId: invitation.householdId, userId, role: invitation.role } });
      const accepted = await tx.householdInvitation.update({ where: { id: invitationId }, data: { status: HouseholdInvitationStatus.ACCEPTED, acceptedAt: new Date() } });
      await this.events.record(tx, {
        aggregateType: 'household-invitation', aggregateId: invitationId,
        eventType: 'orfina.households.invitation-accepted.v1',
        payload: { invitationId, householdId: invitation.householdId, userId, role: invitation.role },
      });
      return accepted;
    });
  }

  private async expireOutstandingInvitations(email: string) {
    await this.prisma.householdInvitation.updateMany({
      where: { email: email.toLowerCase(), status: HouseholdInvitationStatus.PENDING, expiresAt: { lte: new Date() } },
      data: { status: HouseholdInvitationStatus.EXPIRED },
    });
  }
}

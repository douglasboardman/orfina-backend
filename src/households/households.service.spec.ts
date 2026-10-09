import { ForbiddenException } from '@nestjs/common';
import { HouseholdRole } from '@prisma/client';
import { HouseholdsService } from './households.service';

describe('HouseholdsService policies', () => {
  const member = { findUnique: jest.fn() };
  const service = new HouseholdsService({ householdMember: member } as never, {} as never);

  beforeEach(() => jest.clearAllMocks());

  it('blocks a VIEWER from writing financial data', async () => {
    member.findUnique.mockResolvedValue({ role: HouseholdRole.VIEWER });

    await expect(service.assertCanWrite('user_1', 'household_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('permits OWNER, ADMIN and MANAGER to administer finances and settings', async () => {
    member.findUnique.mockResolvedValueOnce({ role: HouseholdRole.OWNER });
    await expect(service.assertCanManage('user_1', 'household_1')).resolves.toEqual({ role: HouseholdRole.OWNER });

    member.findUnique.mockResolvedValueOnce({ role: HouseholdRole.ADMIN });
    await expect(service.assertCanManage('user_2', 'household_1')).resolves.toEqual({ role: HouseholdRole.ADMIN });

    member.findUnique.mockResolvedValueOnce({ role: HouseholdRole.MANAGER });
    await expect(service.assertCanManage('user_3', 'household_1')).resolves.toEqual({ role: HouseholdRole.MANAGER });
  });

  it('keeps member and invitation management restricted to OWNER and ADMIN', async () => {
    member.findUnique.mockResolvedValue({ role: HouseholdRole.MANAGER });

    await expect(service.assertCanManageUsers('user_1', 'household_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks a regular MEMBER from administrative operations', async () => {
    member.findUnique.mockResolvedValue({ role: HouseholdRole.MEMBER });

    await expect(service.assertCanManage('user_1', 'household_1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('renames a household only after management authorization and records the change', async () => {
    const update = jest.fn().mockResolvedValue({ id: 'household_1', name: 'Novo nome', members: [{ role: HouseholdRole.OWNER }] });
    const record = jest.fn();
    const prisma = {
      householdMember: member,
      household: { update },
      $transaction: jest.fn(async (operation: (tx: unknown) => unknown) => operation({ household: { update } })),
    };
    const renameService = new HouseholdsService(prisma as never, { record } as never);
    member.findUnique.mockResolvedValue({ role: HouseholdRole.OWNER });

    await expect(renameService.rename('user_1', 'household_1', 'Novo nome')).resolves.toMatchObject({ name: 'Novo nome' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'household_1' }, data: { name: 'Novo nome' } }));
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'orfina.households.household-renamed.v1', payload: { householdId: 'household_1', name: 'Novo nome' } }));
  });
});

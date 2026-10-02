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

  it('permits OWNER and ADMIN to administer the household', async () => {
    member.findUnique.mockResolvedValueOnce({ role: HouseholdRole.OWNER });
    await expect(service.assertCanManage('user_1', 'household_1')).resolves.toEqual({ role: HouseholdRole.OWNER });

    member.findUnique.mockResolvedValueOnce({ role: HouseholdRole.ADMIN });
    await expect(service.assertCanManage('user_2', 'household_1')).resolves.toEqual({ role: HouseholdRole.ADMIN });
  });

  it('blocks a regular MEMBER from administrative operations', async () => {
    member.findUnique.mockResolvedValue({ role: HouseholdRole.MEMBER });

    await expect(service.assertCanManage('user_1', 'household_1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

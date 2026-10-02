import { BadRequestException } from '@nestjs/common';
import { TransactionType } from '@prisma/client';
import { FinanceService } from './finance.service';

describe('FinanceService transaction rules', () => {
  const prisma = {
    account: { findFirst: jest.fn() },
    subcategory: { findFirst: jest.fn() },
    transaction: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn(),
  };
  const households = { assertCanWrite: jest.fn(), assertMember: jest.fn(), assertCanManage: jest.fn() };
  const service = new FinanceService(prisma as never, households as never, {} as never);
  const dto = { accountId: 'cl111111111111111111111111', subcategoryId: 'cl222222222222222222222222', type: TransactionType.EXPENSE, amount: 1250, description: 'Mercado', occurredOn: '2026-10-02' };

  beforeEach(() => jest.clearAllMocks());

  it('rejects a transaction when its subcategory belongs to the opposite type', async () => {
    households.assertCanWrite.mockResolvedValue({ role: 'MEMBER' });
    prisma.account.findFirst.mockResolvedValue({ id: dto.accountId });
    prisma.subcategory.findFirst.mockResolvedValue({ id: dto.subcategoryId, categoryId: 'cat_1', category: { type: TransactionType.INCOME } });

    await expect(service.createTransaction('user_1', 'household_1', dto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('queries transactions with tenant scope, filters and pagination', async () => {
    households.assertMember.mockResolvedValue({ role: 'MEMBER' });
    prisma.transaction.findMany.mockReturnValue(Promise.resolve([]));
    prisma.transaction.count.mockReturnValue(Promise.resolve(0));
    prisma.$transaction.mockResolvedValue([[], 0]);

    const result = await service.listTransactions('user_1', 'household_1', {
      page: 2, pageSize: 20, type: TransactionType.EXPENSE, accountId: 'cl333333333333333333333333', from: '2026-10-01', to: '2026-10-31',
    });

    expect(result).toEqual({ items: [], total: 0, page: 2, pageSize: 20 });
    expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      skip: 20,
      take: 20,
      where: expect.objectContaining({ householdId: 'household_1', type: TransactionType.EXPENSE, accountId: 'cl333333333333333333333333' }),
    }));
  });
});

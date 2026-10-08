import { ExecutionContext } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { HttpErrorFilter } from '../http-error.filter';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

describe('FinanceController bank catalog validation', () => {
  let app: NestFastifyApplication;
  const finance = {
    createAccount: jest.fn().mockResolvedValue({ id: 'account-fixture' }),
    updateAccount: jest.fn().mockResolvedValue({ id: 'account-fixture' }),
    createCard: jest.fn().mockResolvedValue({ id: 'card-fixture' }),
    updateCard: jest.fn().mockResolvedValue({ id: 'card-fixture' }),
    createInstallmentPurchase: jest.fn().mockResolvedValue({ id: 'installment-fixture' }),
    updateOccurrence: jest.fn().mockResolvedValue({ id: 'transaction-fixture' }),
  };
  const account = { name: 'Banrisul exemplo', type: 'CHECKING', bankName: 'Banrisul', bankLogoUrl: '/assets/banks/bank-037.svg', initialBalance: 0 };
  const card = { name: 'Cartão exemplo', issuerName: 'Banrisul', issuerLogoUrl: account.bankLogoUrl, network: 'MASTERCARD', closingDay: 5, dueDay: 12 };
  const base = '/api/households/household-fixture';

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [FinanceController],
      providers: [{ provide: FinanceService, useValue: finance }],
    }).overrideGuard(JwtAuthGuard).useValue({
      canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest().user = { id: 'user-fixture' };
        return true;
      },
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new HttpErrorFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app.close());

  it('creates the first account with zero balance and the catalog logo', async () => {
    const response = await app.inject({ method: 'POST', url: `${base}/accounts`, payload: account });
    expect(response.statusCode).toBe(201);
    expect(finance.createAccount).toHaveBeenCalledWith('user-fixture', 'household-fixture', account);
  });

  it('edits an account using the same catalog logo', async () => {
    const payload = { bankLogoUrl: account.bankLogoUrl };
    const response = await app.inject({ method: 'PATCH', url: `${base}/accounts/account-fixture`, payload });
    expect(response.statusCode).toBe(200);
    expect(finance.updateAccount).toHaveBeenCalledWith('user-fixture', 'household-fixture', 'account-fixture', payload);
  });

  it('creates and edits cards using local issuer logos', async () => {
    expect((await app.inject({ method: 'POST', url: `${base}/cards`, payload: card })).statusCode).toBe(201);
    expect(finance.createCard).toHaveBeenCalledWith('user-fixture', 'household-fixture', card);
    const payload = { issuerLogoUrl: card.issuerLogoUrl };
    expect((await app.inject({ method: 'PATCH', url: `${base}/cards/card-fixture`, payload })).statusCode).toBe(200);
    expect(finance.updateCard).toHaveBeenCalledWith('user-fixture', 'household-fixture', 'card-fixture', payload);
  });

  it('validates and forwards occurrence edit scope separately from the transaction data', async () => {
    const payload = { accountId: 'cl111111111111111111111111', subcategoryId: 'cl222222222222222222222222', type: 'EXPENSE', amount: 2500, description: 'Parcela ajustada', occurredOn: '2026-11-08', scope: 'FOLLOWING' };
    const response = await app.inject({ method: 'PATCH', url: `${base}/transactions/transaction-fixture/occurrence`, payload });
    expect(response.statusCode).toBe(200);
    expect(finance.updateOccurrence).toHaveBeenCalledWith('user-fixture', 'household-fixture', 'transaction-fixture', expect.objectContaining({ description: 'Parcela ajustada', amount: 2500 }), 'FOLLOWING');
  });

  it('rejects an installment start after its total and forwards a valid start', async () => {
    const payload = { accountId: 'cl111111111111111111111111', subcategoryId: 'cl222222222222222222222222', type: 'EXPENSE', totalAmount: 240_000, installmentCount: 24, startInstallmentNumber: 10, description: 'Empréstimo em andamento', firstOccurredOn: '2026-01-08' };
    expect((await app.inject({ method: 'POST', url: `${base}/installment-purchases`, payload })).statusCode).toBe(201);
    expect(finance.createInstallmentPurchase).toHaveBeenCalledWith('user-fixture', 'household-fixture', payload);
    expect((await app.inject({ method: 'POST', url: `${base}/installment-purchases`, payload: { ...payload, startInstallmentNumber: 25 } })).statusCode).toBe(422);
  });

  it.each(['https://example.test/bank.svg', 'data:image/svg+xml,%3Csvg%3E%3C/svg%3E', undefined])(
    'keeps previously supported logos and optional values (%s)', async (bankLogoUrl) => {
      expect((await app.inject({ method: 'POST', url: `${base}/accounts`, payload: { ...account, bankLogoUrl } })).statusCode).toBe(201);
    },
  );

  it.each(['//example.test/bank.svg', '/api/auth/logout', '/assets/banks/../bank.svg', '/assets/banks/%2e%2e/bank.svg', '/assets/banks/bank-037.svg?redirect=other', 'assets/banks/bank-037.svg'])(
    'rejects non-catalog relative paths before calling persistence (%s)', async (logo) => {
      for (const method of ['POST', 'PATCH'] as const) {
        const suffix = method === 'PATCH' ? '/record-fixture' : '';
        const response = await app.inject({ method, url: `${base}/accounts${suffix}`, payload: { ...account, bankLogoUrl: logo } });
        expect(response.statusCode).toBe(422);
        expect(response.json().issues[0].path).toBe('bankLogoUrl');
        expect((await app.inject({ method, url: `${base}/cards${suffix}`, payload: { ...card, issuerLogoUrl: logo } })).statusCode).toBe(422);
      }
      for (const operation of Object.values(finance)) expect(operation).not.toHaveBeenCalled();
    },
  );

  it.each([{ initialBalance: 0.5 }, { type: 'UNKNOWN' }, { name: '' }])(
    'keeps other account validation rules (%j)', async (invalid) => {
      expect((await app.inject({ method: 'POST', url: `${base}/accounts`, payload: { ...account, ...invalid } })).statusCode).toBe(422);
      expect(finance.createAccount).not.toHaveBeenCalled();
    },
  );
});

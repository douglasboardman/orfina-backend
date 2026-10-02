import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountTransferStatus, AccountType, CardNetwork, CategoryType, TransactionStatus, TransactionType } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { FinanceService } from './finance.service';

const money = z.number().int().min(0).max(999_999_999);
const accountSchema = z.object({ name: z.string().trim().min(2).max(80), type: z.nativeEnum(AccountType), bankName: z.string().trim().max(80).optional(), bankLogoUrl: z.string().url().optional(), initialBalance: z.number().int().min(-999_999_999).max(999_999_999).default(0) });
const accountUpdateSchema = accountSchema.partial();
const cardSchema = z.object({ name: z.string().trim().min(2).max(80), issuerName: z.string().trim().max(80).optional(), issuerLogoUrl: z.string().url().optional(), network: z.nativeEnum(CardNetwork), lastFour: z.string().regex(/^\d{4}$/).optional(), creditLimit: money.optional(), closingDay: z.number().int().min(1).max(28).default(1), dueDay: z.number().int().min(1).max(28).default(10) });
const cardUpdateSchema = cardSchema.partial();
const activeSchema = z.object({ isActive: z.boolean() });
const categorySchema = z.object({ name: z.string().trim().min(2).max(80), type: z.nativeEnum(CategoryType), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#5B5BD6'), icon: z.string().trim().min(1).max(40).default('🏷️') });
const categoryUpdateSchema = categorySchema.pick({ name: true, color: true, icon: true }).partial();
const subcategorySchema = z.object({ name: z.string().trim().min(2).max(80) });
const transactionBaseSchema = z.object({ accountId: z.string().cuid().optional(), cardId: z.string().cuid().optional(), subcategoryId: z.string().cuid(), type: z.nativeEnum(TransactionType), amount: money.positive(), description: z.string().trim().min(2).max(160), occurredOn: z.string().date(), notes: z.string().trim().max(1000).optional() });
const transactionSchema = transactionBaseSchema.extend({ status: z.nativeEnum(TransactionStatus).default(TransactionStatus.POSTED) }).refine((data) => Boolean(data.accountId) !== Boolean(data.cardId), { message: 'Informe exatamente uma conta ou um cartão.', path: ['accountId'] });
const transactionUpdateSchema = transactionBaseSchema.extend({ status: z.nativeEnum(TransactionStatus).optional() }).refine((data) => Boolean(data.accountId) !== Boolean(data.cardId), { message: 'Informe exatamente uma conta ou um cartão.', path: ['accountId'] });
const transactionListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  accountId: z.string().cuid().optional(),
  cardId: z.string().cuid().optional(),
  statementId: z.string().cuid().optional(),
  recurringRuleId: z.string().cuid().optional(),
  categoryId: z.string().cuid().optional(),
  subcategoryId: z.string().cuid().optional(),
  type: z.nativeEnum(TransactionType).optional(),
  status: z.nativeEnum(TransactionStatus).optional(),
  importBatchId: z.string().cuid().optional(),
});
const transferSchema = z.object({ sourceAccountId: z.string().cuid(), destinationAccountId: z.string().cuid(), amount: money.positive(), occurredOn: z.string().date(), description: z.string().trim().min(2).max(160).optional(), status: z.nativeEnum(AccountTransferStatus).default(AccountTransferStatus.POSTED) }).refine((data) => data.sourceAccountId !== data.destinationAccountId, { message: 'Origem e destino devem ser diferentes.', path: ['destinationAccountId'] });
const paymentSchema = z.object({ accountId: z.string().cuid(), amount: money.positive(), paidOn: z.string().date(), idempotencyKey: z.string().trim().min(8).max(120) });
const installmentSchema = z.object({ cardId: z.string().cuid(), subcategoryId: z.string().cuid(), type: z.nativeEnum(TransactionType), totalAmount: money.positive(), installmentCount: z.number().int().min(2).max(120), description: z.string().trim().min(2).max(160), firstOccurredOn: z.string().date(), notes: z.string().trim().max(1000).optional() });
const recurringRuleSchema = z.object({ accountId: z.string().cuid().optional(), cardId: z.string().cuid().optional(), subcategoryId: z.string().cuid(), type: z.nativeEnum(TransactionType), amount: money.positive(), description: z.string().trim().min(2).max(160), notes: z.string().trim().max(1000).optional(), startOn: z.string().date(), endOn: z.string().date().optional() }).refine((data) => Boolean(data.accountId) !== Boolean(data.cardId), { message: 'Informe exatamente uma conta ou um cartão.', path: ['accountId'] }).refine((data) => !data.endOn || data.endOn >= data.startOn, { message: 'A data final deve ser posterior à inicial.', path: ['endOn'] });

@Controller('households/:householdId')
@UseGuards(JwtAuthGuard)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('overview') overview(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.overview(user.id, householdId); }
  @Get('accounts') listAccounts(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.listAccounts(user.id, householdId); }
  @Post('accounts') createAccount(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createAccount(user.id, householdId, accountSchema.parse(body)); }
  @Patch('accounts/:accountId') updateAccount(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('accountId') accountId: string, @Body() body: unknown) { return this.finance.updateAccount(user.id, householdId, accountId, accountUpdateSchema.parse(body)); }
  @Patch('accounts/:accountId/status') setAccountStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('accountId') accountId: string, @Body() body: unknown) { return this.finance.setAccountStatus(user.id, householdId, accountId, activeSchema.parse(body).isActive); }
  @Get('cards') listCards(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.listCards(user.id, householdId); }
  @Post('cards') createCard(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createCard(user.id, householdId, cardSchema.parse(body)); }
  @Patch('cards/:cardId') updateCard(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('cardId') cardId: string, @Body() body: unknown) { return this.finance.updateCard(user.id, householdId, cardId, cardUpdateSchema.parse(body)); }
  @Patch('cards/:cardId/status') setCardStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('cardId') cardId: string, @Body() body: unknown) { return this.finance.setCardStatus(user.id, householdId, cardId, activeSchema.parse(body).isActive); }
  @Get('cards/:cardId/statements') listCardStatements(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('cardId') cardId: string) { return this.finance.listCardStatements(user.id, householdId, cardId); }
  @Post('statements/:statementId/close') closeStatement(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('statementId') statementId: string) { return this.finance.closeStatement(user.id, householdId, statementId); }
  @Post('statements/:statementId/payments') payStatement(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('statementId') statementId: string, @Body() body: unknown) { return this.finance.payStatement(user.id, householdId, statementId, paymentSchema.parse(body)); }
  @Post('installment-purchases') createInstallmentPurchase(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createInstallmentPurchase(user.id, householdId, installmentSchema.parse(body)); }
  @Get('installment-purchases') listInstallmentPurchases(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.listInstallmentPurchases(user.id, householdId); }
  @Post('installment-purchases/:purchaseId/cancel-future') cancelFutureInstallments(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('purchaseId') purchaseId: string) { return this.finance.cancelFutureInstallments(user.id, householdId, purchaseId); }
  @Get('recurring-rules') listRecurringRules(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.listRecurringRules(user.id, householdId); }
  @Post('recurring-rules') createRecurringRule(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createRecurringRule(user.id, householdId, recurringRuleSchema.parse(body)); }
  @Patch('recurring-rules/:ruleId/status') setRecurringRuleStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('ruleId') ruleId: string, @Body() body: unknown) { return this.finance.setRecurringRuleStatus(user.id, householdId, ruleId, z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'ENDED']) }).parse(body).status); }
  @Get('categories') listCategories(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.listCategories(user.id, householdId); }
  @Post('categories') createCategory(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createCategory(user.id, householdId, categorySchema.parse(body)); }
  @Patch('categories/:categoryId') updateCategory(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('categoryId') categoryId: string, @Body() body: unknown) { return this.finance.updateCategory(user.id, householdId, categoryId, categoryUpdateSchema.parse(body)); }
  @Patch('categories/:categoryId/status') setCategoryStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('categoryId') categoryId: string, @Body() body: unknown) { return this.finance.setCategoryStatus(user.id, householdId, categoryId, activeSchema.parse(body).isActive); }
  @Post('categories/:categoryId/subcategories') createSubcategory(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('categoryId') categoryId: string, @Body() body: unknown) { return this.finance.createSubcategory(user.id, householdId, categoryId, subcategorySchema.parse(body)); }
  @Patch('subcategories/:subcategoryId') updateSubcategory(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('subcategoryId') subcategoryId: string, @Body() body: unknown) { return this.finance.updateSubcategory(user.id, householdId, subcategoryId, subcategorySchema.parse(body)); }
  @Patch('subcategories/:subcategoryId/status') setSubcategoryStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('subcategoryId') subcategoryId: string, @Body() body: unknown) { return this.finance.setSubcategoryStatus(user.id, householdId, subcategoryId, activeSchema.parse(body).isActive); }
  @Get('transactions') listTransactions(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Query() query: unknown) { return this.finance.listTransactions(user.id, householdId, transactionListSchema.parse(query)); }
  @Post('transactions') createTransaction(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createTransaction(user.id, householdId, transactionSchema.parse(body)); }
  @Patch('transactions/:transactionId') updateTransaction(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('transactionId') transactionId: string, @Body() body: unknown) { return this.finance.updateTransaction(user.id, householdId, transactionId, transactionUpdateSchema.parse(body)); }
  @Delete('transactions/:transactionId') deleteTransaction(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('transactionId') transactionId: string) { return this.finance.deleteTransaction(user.id, householdId, transactionId); }
  @Patch('transactions/:transactionId/status') setTransactionStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('transactionId') transactionId: string, @Body() body: unknown) { return this.finance.setTransactionStatus(user.id, householdId, transactionId, z.object({ status: z.nativeEnum(TransactionStatus) }).parse(body).status); }
  @Get('transfers') listTransfers(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.listTransfers(user.id, householdId); }
  @Post('transfers') createTransfer(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createTransfer(user.id, householdId, transferSchema.parse(body)); }
  @Patch('transfers/:transferId/status') setTransferStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('transferId') transferId: string, @Body() body: unknown) { return this.finance.setTransferStatus(user.id, householdId, transferId, z.object({ status: z.nativeEnum(AccountTransferStatus) }).parse(body).status); }
}

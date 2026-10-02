import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AccountType, CategoryType, TransactionType } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { FinanceService } from './finance.service';

const money = z.number().int().min(0).max(999_999_999);
const accountSchema = z.object({ name: z.string().trim().min(2).max(80), type: z.nativeEnum(AccountType), bankName: z.string().trim().max(80).optional(), bankLogoUrl: z.string().url().optional(), initialBalance: z.number().int().min(-999_999_999).max(999_999_999).default(0) });
const accountUpdateSchema = accountSchema.partial();
const activeSchema = z.object({ isActive: z.boolean() });
const categorySchema = z.object({ name: z.string().trim().min(2).max(80), type: z.nativeEnum(CategoryType), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#5B5BD6'), icon: z.string().trim().min(1).max(40).default('🏷️') });
const categoryUpdateSchema = categorySchema.pick({ name: true, color: true, icon: true }).partial();
const subcategorySchema = z.object({ name: z.string().trim().min(2).max(80) });
const transactionSchema = z.object({ accountId: z.string().cuid(), subcategoryId: z.string().cuid(), type: z.nativeEnum(TransactionType), amount: money.positive(), description: z.string().trim().min(2).max(160), occurredOn: z.string().date(), notes: z.string().trim().max(1000).optional() });
const transactionListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  accountId: z.string().cuid().optional(),
  categoryId: z.string().cuid().optional(),
  subcategoryId: z.string().cuid().optional(),
  type: z.nativeEnum(TransactionType).optional(),
});

@Controller('households/:householdId')
@UseGuards(JwtAuthGuard)
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('overview') overview(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.overview(user.id, householdId); }
  @Get('accounts') listAccounts(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.listAccounts(user.id, householdId); }
  @Post('accounts') createAccount(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createAccount(user.id, householdId, accountSchema.parse(body)); }
  @Patch('accounts/:accountId') updateAccount(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('accountId') accountId: string, @Body() body: unknown) { return this.finance.updateAccount(user.id, householdId, accountId, accountUpdateSchema.parse(body)); }
  @Patch('accounts/:accountId/status') setAccountStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('accountId') accountId: string, @Body() body: unknown) { return this.finance.setAccountStatus(user.id, householdId, accountId, activeSchema.parse(body).isActive); }
  @Get('categories') listCategories(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.finance.listCategories(user.id, householdId); }
  @Post('categories') createCategory(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createCategory(user.id, householdId, categorySchema.parse(body)); }
  @Patch('categories/:categoryId') updateCategory(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('categoryId') categoryId: string, @Body() body: unknown) { return this.finance.updateCategory(user.id, householdId, categoryId, categoryUpdateSchema.parse(body)); }
  @Patch('categories/:categoryId/status') setCategoryStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('categoryId') categoryId: string, @Body() body: unknown) { return this.finance.setCategoryStatus(user.id, householdId, categoryId, activeSchema.parse(body).isActive); }
  @Post('categories/:categoryId/subcategories') createSubcategory(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('categoryId') categoryId: string, @Body() body: unknown) { return this.finance.createSubcategory(user.id, householdId, categoryId, subcategorySchema.parse(body)); }
  @Patch('subcategories/:subcategoryId') updateSubcategory(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('subcategoryId') subcategoryId: string, @Body() body: unknown) { return this.finance.updateSubcategory(user.id, householdId, subcategoryId, subcategorySchema.parse(body)); }
  @Patch('subcategories/:subcategoryId/status') setSubcategoryStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('subcategoryId') subcategoryId: string, @Body() body: unknown) { return this.finance.setSubcategoryStatus(user.id, householdId, subcategoryId, activeSchema.parse(body).isActive); }
  @Get('transactions') listTransactions(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Query() query: unknown) { return this.finance.listTransactions(user.id, householdId, transactionListSchema.parse(query)); }
  @Post('transactions') createTransaction(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.finance.createTransaction(user.id, householdId, transactionSchema.parse(body)); }
  @Patch('transactions/:transactionId') updateTransaction(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('transactionId') transactionId: string, @Body() body: unknown) { return this.finance.updateTransaction(user.id, householdId, transactionId, transactionSchema.parse(body)); }
  @Delete('transactions/:transactionId') deleteTransaction(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('transactionId') transactionId: string) { return this.finance.deleteTransaction(user.id, householdId, transactionId); }
}

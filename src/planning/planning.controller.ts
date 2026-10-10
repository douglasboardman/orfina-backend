import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { SavingsGoalStatus } from '@prisma/client';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { PlanningService } from './planning.service';

const money = z.number().int().positive().max(999_999_999);
const month = z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/);
const budget = z.object({ categoryId: z.string().cuid(), limitAmount: z.number().int().min(0).max(999_999_999), notes: z.string().trim().max(1000).optional() });
const goal = z.object({ name: z.string().trim().min(2).max(100), targetAmount: money, targetDate: z.string().date().optional(), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#5B5BD6'), icon: z.string().trim().max(40).optional() });
const contribution = z.object({ amount: money, occurredOn: z.string().date(), notes: z.string().trim().max(1000).optional(), idempotencyKey: z.string().trim().min(8).max(120) });

@Controller('households/:householdId')
@UseGuards(JwtAuthGuard)
export class PlanningController {
  constructor(private readonly planning: PlanningService) {}
  @Get('budgets') budgetSummary(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Query('month') value?: string) { return this.planning.budgetSummary(user.id, householdId, month.parse(value ?? new Date().toISOString().slice(0, 7))); }
  @Put('budgets/:month') upsertBudget(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('month') value: string, @Body() body: unknown) { return this.planning.upsertBudget(user.id, householdId, month.parse(value), budget.parse(body)); }
  @Delete('budgets/:month/:categoryId') deleteBudget(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('month') value: string, @Param('categoryId') categoryId: string) { return this.planning.deleteBudget(user.id, householdId, month.parse(value), z.string().cuid().parse(categoryId)); }
  @Post('budgets/copy') copyBudgets(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { const input = z.object({ sourceMonth: month, targetMonth: month }).parse(body); return this.planning.copyBudgets(user.id, householdId, input.sourceMonth, input.targetMonth); }
  @Post('budgets/:month/close') closeBudget(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('month') value: string) { return this.planning.setMonthClosed(user.id, householdId, month.parse(value), true); }
  @Post('budgets/:month/reopen') reopenBudget(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('month') value: string) { return this.planning.setMonthClosed(user.id, householdId, month.parse(value), false); }
  @Get('goals') listGoals(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.planning.listGoals(user.id, householdId); }
  @Get('archived-goals') listArchivedGoals(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.planning.listArchivedGoals(user.id, householdId); }
  @Post('goals') createGoal(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.planning.createGoal(user.id, householdId, goal.parse(body)); }
  @Patch('goals/:goalId/status') setGoalStatus(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('goalId') goalId: string, @Body() body: unknown) { return this.planning.setGoalStatus(user.id, householdId, z.string().cuid().parse(goalId), z.object({ status: z.nativeEnum(SavingsGoalStatus) }).parse(body).status); }
  @Delete('goals/:goalId') deleteArchivedGoal(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('goalId') goalId: string) { return this.planning.deleteArchivedGoal(user.id, householdId, z.string().cuid().parse(goalId)); }
  @Post('goals/:goalId/contributions') contribute(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('goalId') goalId: string, @Body() body: unknown) { return this.planning.contributeToGoal(user.id, householdId, z.string().cuid().parse(goalId), contribution.parse(body)); }
}

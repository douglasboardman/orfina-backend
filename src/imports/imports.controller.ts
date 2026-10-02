import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/jwt.strategy';
import { ImportsService } from './imports.service';

const column = z.string().trim().min(1).max(100).optional();
const mapping = z.object({
  date: column, description: column, amount: column, type: column, category: column, subcategory: column,
  status: column, account: column, sourceAccount: column, destinationAccount: column,
}).partial();
const upload = z.object({
  fileName: z.string().trim().min(1).max(160),
  contentBase64: z.string().min(1).max(4_000_000),
  mapping,
  accountId: z.string().cuid().optional(),
});

@Controller('households/:householdId/imports')
@UseGuards(JwtAuthGuard)
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get() list(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) { return this.imports.list(user.id, householdId); }
  @Get(':batchId') get(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('batchId') batchId: string) { return this.imports.get(user.id, householdId, batchId); }
  @Post() preview(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Body() body: unknown) { return this.imports.preview(user.id, householdId, upload.parse(body)); }
  @Post(':batchId/commit') commit(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('batchId') batchId: string, @Body() body: unknown) { return this.imports.commit(user.id, householdId, batchId, z.object({ createMissingCategories: z.boolean().default(false) }).parse(body)); }
  @Post(':batchId/cancel') cancel(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('batchId') batchId: string) { return this.imports.cancel(user.id, householdId, batchId); }
}

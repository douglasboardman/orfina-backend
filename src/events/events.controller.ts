import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EventsService } from './events.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { AuthenticatedUser } from '../auth/jwt.strategy';

@Controller('events')
@UseGuards(JwtAuthGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get('outbox/metrics')
  outboxMetrics() {
    return this.events.outboxMetrics();
  }

  @Get('outbox/households/:householdId/failed')
  failed(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string) {
    return this.events.listFailedForHousehold(user.id, householdId);
  }

  @Post('outbox/households/:householdId/failed/:eventId/requeue')
  requeue(@CurrentUser() user: AuthenticatedUser, @Param('householdId') householdId: string, @Param('eventId') eventId: string) {
    return this.events.requeueFailedForHousehold(user.id, householdId, eventId);
  }
}

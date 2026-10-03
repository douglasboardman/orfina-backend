import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { OutboxRelay } from './outbox.relay';

@Module({
  controllers: [EventsController],
  providers: [EventsService, OutboxRelay, PrismaService],
  exports: [EventsService, OutboxRelay],
})
export class EventsModule {}

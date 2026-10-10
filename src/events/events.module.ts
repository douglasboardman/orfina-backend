import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { OutboxRelay } from './outbox.relay';

@Module({
  imports: [PrismaModule],
  controllers: [EventsController],
  providers: [EventsService, OutboxRelay],
  exports: [EventsService, OutboxRelay],
})
export class EventsModule {}

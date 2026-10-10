import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { HouseholdsModule } from '../households/households.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { RecurringWorker } from './recurring.worker';

@Module({
  imports: [PrismaModule, HouseholdsModule, EventsModule],
  controllers: [FinanceController],
  providers: [FinanceService, RecurringWorker],
})
export class FinanceModule {}

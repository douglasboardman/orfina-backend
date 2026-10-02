import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { HouseholdsModule } from '../households/households.module';
import { PrismaService } from '../prisma/prisma.service';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  imports: [HouseholdsModule, EventsModule],
  controllers: [FinanceController],
  providers: [FinanceService, PrismaService],
})
export class FinanceModule {}

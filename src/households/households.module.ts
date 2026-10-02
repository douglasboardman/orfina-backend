import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { PrismaService } from '../prisma/prisma.service';
import { HouseholdsController } from './households.controller';
import { HouseholdsService } from './households.service';

@Module({
  imports: [EventsModule],
  controllers: [HouseholdsController],
  providers: [HouseholdsService, PrismaService],
  exports: [HouseholdsService],
})
export class HouseholdsModule {}

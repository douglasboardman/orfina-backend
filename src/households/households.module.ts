import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { PrismaModule } from '../prisma/prisma.module';
import { HouseholdsController } from './households.controller';
import { HouseholdsService } from './households.service';

@Module({
  imports: [PrismaModule, EventsModule],
  controllers: [HouseholdsController],
  providers: [HouseholdsService],
  exports: [HouseholdsService],
})
export class HouseholdsModule {}

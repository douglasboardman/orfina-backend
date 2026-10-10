import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { HouseholdsModule } from '../households/households.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [PrismaModule, HouseholdsModule, EventsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}

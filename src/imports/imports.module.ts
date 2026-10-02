import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { HouseholdsModule } from '../households/households.module';
import { PrismaService } from '../prisma/prisma.service';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [HouseholdsModule, EventsModule],
  controllers: [ImportsController],
  providers: [ImportsService, PrismaService],
})
export class ImportsModule {}

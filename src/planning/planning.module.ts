import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { HouseholdsModule } from '../households/households.module';
import { PrismaService } from '../prisma/prisma.service';
import { PlanningController } from './planning.controller';
import { PlanningService } from './planning.service';

@Module({ imports: [HouseholdsModule, EventsModule], controllers: [PlanningController], providers: [PlanningService, PrismaService] })
export class PlanningModule {}

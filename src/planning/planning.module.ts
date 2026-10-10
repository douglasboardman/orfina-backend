import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { HouseholdsModule } from '../households/households.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PlanningController } from './planning.controller';
import { PlanningService } from './planning.service';

@Module({ imports: [PrismaModule, HouseholdsModule, EventsModule], controllers: [PlanningController], providers: [PlanningService] })
export class PlanningModule {}

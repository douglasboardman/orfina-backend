import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { HouseholdsModule } from './households/households.module';
import { FinanceModule } from './finance/finance.module';
import { PrismaService } from './prisma/prisma.service';
import { EventsModule } from './events/events.module';
import { PlanningModule } from './planning/planning.module';
import { ImportsModule } from './imports/imports.module';
import { VersionController } from './version.controller';
import { HealthController } from './health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    HouseholdsModule,
    FinanceModule,
    EventsModule,
    PlanningModule,
    ImportsModule,
  ],
  controllers: [VersionController, HealthController],
  providers: [PrismaService],
})
export class AppModule {}

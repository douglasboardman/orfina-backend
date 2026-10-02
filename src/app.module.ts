import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { HouseholdsModule } from './households/households.module';
import { FinanceModule } from './finance/finance.module';
import { PrismaService } from './prisma/prisma.service';
import { EventsModule } from './events/events.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AuthModule,
    HouseholdsModule,
    FinanceModule,
    EventsModule,
  ],
  providers: [PrismaService],
})
export class AppModule {}

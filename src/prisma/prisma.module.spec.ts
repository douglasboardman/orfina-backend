import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../app.module';
import { PrismaService } from './prisma.service';
import { AuthService } from '../auth/auth.service';
import { AdminService } from '../identity/admin.service';
import { HouseholdsService } from '../households/households.service';
import { EventsService } from '../events/events.service';
import { OutboxRelay } from '../events/outbox.relay';
import { FinanceService } from '../finance/finance.service';
import { PlanningService } from '../planning/planning.service';
import { ImportsService } from '../imports/imports.service';
import { HealthController } from '../health.controller';

describe('application Prisma ownership', () => {
  it('creates exactly one client shared by every database consumer', async () => {
    let instances = 0;
    const app = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService).useValue({ getOrThrow: () => 'unit-test-only-secret' })
      .overrideProvider(PrismaService).useFactory({ factory: () => ({ instance: ++instances }) })
      .compile();
    try {
      expect(instances).toBe(1);
      const shared = app.get(PrismaService);
      for (const consumer of [AuthService, AdminService, HouseholdsService, EventsService, OutboxRelay, FinanceService, PlanningService, ImportsService, HealthController]) {
        expect((app.get(consumer) as unknown as { prisma: PrismaService }).prisma).toBe(shared);
      }
    } finally { await app.close(); }
  });
});

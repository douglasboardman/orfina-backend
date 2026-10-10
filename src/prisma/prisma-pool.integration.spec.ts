import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../app.module';
import { PrismaService } from './prisma.service';
import { FinanceService } from '../finance/finance.service';
import { PlanningService } from '../planning/planning.service';
import { ImportsService } from '../imports/imports.service';
import { HealthController } from '../health.controller';

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;
describeWithDatabase('shared Prisma pool (disposable local database)', () => {
  let app: TestingModule;
  const previous = { events: process.env.EVENTS_ENABLED, recurring: process.env.RECURRING_WORKER_ENABLED };
  beforeAll(async () => {
    process.env.EVENTS_ENABLED = 'false';
    process.env.RECURRING_WORKER_ENABLED = 'false';
    app = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService).useValue({ getOrThrow: () => 'local-integration-only-secret' })
      .compile();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    for (const [key, value] of [['EVENTS_ENABLED', previous.events], ['RECURRING_WORKER_ENABLED', previous.recurring]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('queues 32 concurrent queries from different domains within one bounded pool', async () => {
    const clients = [FinanceService, PlanningService, ImportsService].map(consumer =>
      (app.get(consumer) as unknown as { prisma: PrismaService }).prisma);
    expect(clients.every(client => client === app.get(PrismaService))).toBe(true);
    const results = await Promise.all(Array.from({ length: 32 }, (_, i) =>
      clients[i % clients.length].$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM pg_sleep(0.03)`));
    const limit = Number(new URL(process.env.DATABASE_URL!).searchParams.get('connection_limit') ?? 5);
    const connections = new Set(results.flat().map(row => row.pid)).size;
    expect(connections).toBeLessThanOrEqual(limit);
    console.info(JSON.stringify({ test: 'shared-prisma-pool', concurrentQueries: 32, connections, limit }));
    expect(results.every(rows => rows.length === 1)).toBe(true);
    expect(await app.get(HealthController).ready()).toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('keeps concurrent interactive transactions bound to their own connections', async () => {
    const prisma = app.get(PrismaService);
    await Promise.all(Array.from({ length: 4 }, () => prisma.$transaction(async tx => {
      const first = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const next = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid FROM pg_sleep(0.03)`;
      expect(next[0].pid).toBe(first[0].pid);
    })));
  });
});

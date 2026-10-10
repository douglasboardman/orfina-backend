import { INestApplication, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { databaseUrlWithPoolDefaults } from './connection-pool';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const datasourceUrl = databaseUrlWithPoolDefaults(process.env.DATABASE_URL);
    super(datasourceUrl ? { datasourceUrl } : undefined);
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', () => void app.close());
  }
}

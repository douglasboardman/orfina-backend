import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { OutboxRelay } from './events/outbox.relay';
import { PrismaService } from './prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly outbox: OutboxRelay) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'unavailable' });
    }
    const outbox = this.outbox.health();
    if (outbox.enabled && !outbox.connected) {
      throw new ServiceUnavailableException({ status: 'degraded', database: 'ok', outbox });
    }
    return { status: 'ok', database: 'ok', outbox };
  }
}

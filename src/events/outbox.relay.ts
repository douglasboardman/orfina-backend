import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { connect, JetStreamClient, NatsConnection, StringCodec } from 'nats';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OutboxRelay implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private connection?: NatsConnection;
  private jetstream?: JetStreamClient;
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private connecting = false;
  private readonly codec = StringCodec();
  private readonly intervalMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 5000);
  private readonly maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 10);
  private readonly baseBackoffMs = Number(process.env.OUTBOX_BACKOFF_BASE_MS ?? 5000);
  private readonly maxBackoffMs = Number(process.env.OUTBOX_BACKOFF_MAX_MS ?? 3_600_000);
  private readonly leaseMs = Number(process.env.OUTBOX_LEASE_MS ?? 30_000);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    if (process.env.EVENTS_ENABLED !== 'true') return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    await this.tick();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.connection?.drain();
  }

  health() {
    return {
      enabled: process.env.EVENTS_ENABLED === 'true',
      connected: Boolean(this.jetstream),
    };
  }

  private async tick() {
    await this.ensureConnection();
    await this.flush();
  }

  private async ensureConnection() {
    if (this.jetstream || this.connecting) return;
    this.connecting = true;
    try {
      this.connection = await connect({ servers: process.env.NATS_URL ?? 'nats://localhost:4222', timeout: 1000 });
      const manager = await this.connection.jetstreamManager();
      try {
        await manager.streams.info('ORFINA_EVENTS');
      } catch {
        await manager.streams.add({ name: 'ORFINA_EVENTS', subjects: ['orfina.>'] });
      }
      this.jetstream = this.connection.jetstream();
      this.logger.log(JSON.stringify({ event: 'outbox.broker-connected', url: process.env.NATS_URL ?? 'nats://localhost:4222' }));
    } catch (error: unknown) {
      this.connection = undefined;
      this.jetstream = undefined;
      this.logger.warn(JSON.stringify({ event: 'outbox.broker-unavailable', message: this.errorMessage(error) }));
    } finally {
      this.connecting = false;
    }
  }

  private async flush() {
    if (!this.jetstream || this.flushing) return;
    this.flushing = true;
    try {
      const now = new Date();
      const pending = await this.prisma.outboxEvent.findMany({
        where: {
          status: 'PENDING',
          AND: [
            { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
            { OR: [{ claimToken: null }, { claimedAt: { lte: new Date(now.getTime() - this.leaseMs) } }] },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const event of pending) {
        const claimToken = randomUUID();
        const claimed = await this.prisma.outboxEvent.updateMany({
          where: {
            id: event.id,
            status: 'PENDING',
            OR: [{ claimToken: null }, { claimedAt: { lte: new Date(now.getTime() - this.leaseMs) } }],
          },
          data: { claimToken, claimedAt: new Date() },
        });
        if (!claimed.count) continue;
        try {
          await this.jetstream.publish(event.eventType, this.codec.encode(JSON.stringify({ id: event.id, version: event.version, payload: event.payload, occurredAt: event.createdAt })));
          await this.prisma.outboxEvent.updateMany({
            where: { id: event.id, claimToken },
            data: { status: 'PUBLISHED', publishedAt: new Date(), attempts: { increment: 1 }, nextAttemptAt: null, lastError: null, claimToken: null, claimedAt: null },
          });
          this.logger.debug(JSON.stringify({ event: 'outbox.published', eventId: event.id, eventType: event.eventType, attempts: event.attempts + 1 }));
        } catch (error: unknown) {
          await this.handlePublishFailure(event, claimToken, error);
          this.jetstream = undefined;
          await this.connection?.close();
          this.connection = undefined;
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async handlePublishFailure(event: { id: string; eventType: string; attempts: number }, claimToken: string, error: unknown) {
    const attempts = event.attempts + 1;
    const failed = attempts >= this.maxAttempts;
    const delay = Math.min(this.baseBackoffMs * 2 ** Math.max(0, attempts - 1), this.maxBackoffMs);
    const message = this.errorMessage(error);
    await this.prisma.outboxEvent.updateMany({
      where: { id: event.id, claimToken },
      data: {
        attempts,
        status: failed ? 'FAILED' : 'PENDING',
        nextAttemptAt: failed ? null : new Date(Date.now() + delay),
        lastError: message,
        claimToken: null,
        claimedAt: null,
      },
    });
    this.logger.warn(JSON.stringify({
      event: failed ? 'outbox.failed' : 'outbox.retry-scheduled',
      eventId: event.id,
      eventType: event.eventType,
      attempts,
      nextAttemptInMs: failed ? null : delay,
      message,
    }));
  }

  private errorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido ao publicar evento.';
    return message.slice(0, 1000);
  }
}

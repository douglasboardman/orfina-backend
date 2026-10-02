import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FinanceService } from './finance.service';

/**
 * A deliberately small scheduler. Database uniqueness, not scheduler timing,
 * provides the delivery guarantee, so multiple application instances are safe.
 */
@Injectable()
export class RecurringWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecurringWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly intervalMs = Number(process.env.RECURRING_POLL_INTERVAL_MS ?? 60 * 60 * 1000);

  constructor(private readonly finance: FinanceService) {}

  async onModuleInit() {
    if (process.env.RECURRING_WORKER_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.run(), this.intervalMs);
    await this.run();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      const generated = await this.finance.materializeRecurringRules();
      if (generated) this.logger.log(JSON.stringify({ event: 'recurring.materialized', generated }));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      this.logger.error(JSON.stringify({ event: 'recurring.failed', message }));
    } finally {
      this.running = false;
    }
  }
}

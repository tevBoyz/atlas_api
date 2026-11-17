import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { DatabaseService } from '../db/database.service';
import { MIGRATIONS_TABLE } from '../db/tooling/migrate';
import { ROOT_LOGGER } from '../observability/logger';
import { RedisService } from '../redis/redis.service';
import { EXPECTED_MIGRATIONS, type ExpectedMigrations } from './expected-migrations';
import { checkMigrationsApplied, type ReadinessReport, runReadinessChecks } from './readiness';

/** DI token: per-check timeout in ms (tests shorten it). */
export const READINESS_TIMEOUT_MS = Symbol('READINESS_TIMEOUT_MS');

/**
 * Runs the readiness checks (API-100-07 AC2): a DB query, a Redis PING and the migrations check.
 *
 * Logging (AC3): `/readyz` is polled often, so results are not logged per call. Only changes are
 * logged: the first result after startup and every switch between ready and unavailable
 * (unavailable at warn with the failing checks and reasons, ready at info).
 */
@Injectable()
export class ReadinessService {
  private lastFailed: string | undefined;

  constructor(
    private readonly database: DatabaseService,
    private readonly redis: RedisService,
    @Inject(EXPECTED_MIGRATIONS) private readonly expected: ExpectedMigrations,
    @Inject(READINESS_TIMEOUT_MS) private readonly timeoutMs: number,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async check(): Promise<ReadinessReport> {
    const report = await runReadinessChecks(
      {
        db: () => this.database.ping(),
        redis: () => this.redis.ping(),
        migrations: () => this.checkMigrations(),
      },
      this.timeoutMs,
    );
    this.logChange(report);
    return report;
  }

  private async checkMigrations(): Promise<void> {
    if ('error' in this.expected) throw new Error(this.expected.error);
    await checkMigrationsApplied(this.expected.ids, async (ids) => {
      const rows = await this.database.query<{ id: string }>(
        `select id from ${MIGRATIONS_TABLE} where id = any($1::text[])`,
        [ids],
      );
      return rows.map((row) => row.id);
    });
  }

  private logChange(report: ReadinessReport): void {
    const key = report.failed.join(',');
    if (key === this.lastFailed) return;
    this.lastFailed = key;
    if (report.ready) this.logger.info('readiness: ready');
    else
      this.logger.warn(
        { failed: report.failed, reasons: report.reasons },
        'readiness: unavailable',
      );
  }
}

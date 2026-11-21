import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { Redis } from 'ioredis';

import { usageDay, usageKeys } from '../../../common/auth/token-usage';
import { ALLOW_REMOTE_FLAG, LOCAL_HOSTS } from '../../../db/tooling/target-guard';

/**
 * `npm run -s auth:token-usage [-- --days 14] [--allow-remote]` (API-100-59 AC2): the share of
 * Supabase access tokens per UTC day during the dual-token window, from the counters the API writes
 * to Redis (`TokenUsageMetrics`): requests and distinct users per issuer. When the Supabase share
 * has been 0 for long enough (or on the date Dawit sets), turn Supabase tokens off with
 * SUPABASE_JWT_ACCEPT=false (or SUPABASE_JWT_ACCEPT_UNTIL). REDIS_URL as the API reads it (the
 * environment, then `.env`, then the local compose Redis); local hosts only unless `--allow-remote`.
 * Prints counts only (no user ids).
 */

const LOCAL_REDIS = 'redis://127.0.0.1:63799';

export interface UsageRow {
  day: string;
  supabase_requests: number;
  atlas_requests: number;
  supabase_share: number | null;
  supabase_users: number;
  atlas_users: number;
}

/** The last `days` UTC days, newest first. */
export async function readUsage(redis: Redis, days: number, now = Date.now()): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  for (let i = 0; i < days; i += 1) {
    const day = usageDay(now - i * 86_400_000);
    const keys = usageKeys(day);
    const counts = await redis.hgetall(keys.counts);
    const supabase = Number(counts.supabase ?? 0);
    const atlas = Number(counts.atlas ?? 0);
    rows.push({
      day,
      supabase_requests: supabase,
      atlas_requests: atlas,
      supabase_share:
        supabase + atlas === 0 ? null : Math.round((supabase / (supabase + atlas)) * 1000) / 1000,
      supabase_users: await redis.pfcount(keys.users('supabase')),
      atlas_users: await redis.pfcount(keys.users('atlas')),
    });
  }
  return rows;
}

function redisUrl(): string {
  const fromEnv = process.env.REDIS_URL?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync('.env')) {
    const fromFile = parseEnv(readFileSync('.env', 'utf8')).REDIS_URL?.trim();
    if (fromFile) return fromFile;
  }
  return LOCAL_REDIS;
}

async function main(argv: readonly string[]): Promise<number> {
  const daysIndex = argv.indexOf('--days');
  const days = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : 14;
  if (!Number.isInteger(days) || days < 1 || days > 40) {
    process.stderr.write('usage: npm run -s auth:token-usage -- [--days 1-40] [--allow-remote]\n');
    return 2;
  }
  const url = new URL(redisUrl());
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!LOCAL_HOSTS.includes(host) && !argv.includes(ALLOW_REMOTE_FLAG)) {
    process.stderr.write(
      `REDIS_URL is not local (${host}); pass ${ALLOW_REMOTE_FLAG} to read it.\n`,
    );
    return 2;
  }
  const redis = new Redis(url.toString(), { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    const rows = await readUsage(redis, days);
    process.stdout.write(
      'day         supabase  atlas  supabase_share  supabase_users  atlas_users\n',
    );
    for (const r of rows) {
      const share = r.supabase_share === null ? '-' : r.supabase_share.toFixed(3);
      process.stdout.write(
        `${r.day}  ${String(r.supabase_requests).padStart(8)}  ${String(r.atlas_requests).padStart(5)}  ${share.padStart(14)}  ${String(r.supabase_users).padStart(14)}  ${String(r.atlas_users).padStart(11)}\n`,
      );
    }
    return 0;
  } finally {
    redis.disconnect();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('token usage could not be read (is Redis running?)\n');
      process.exitCode = 1;
    },
  );
}

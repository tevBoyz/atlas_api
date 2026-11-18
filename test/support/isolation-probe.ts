import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import type { Client } from 'pg';

import { openTestClient } from './database';

/**
 * Shared body of the isolation specs (API-100-13): each of several spec files commits a marker row
 * and a Redis key, holds them for a moment, and must never see a marker from another file, whether
 * the files run in parallel (different workers) or one after the other (same worker, re-cloned).
 */
const MARKER_USER = '00000000-0000-4000-8000-0000000000aa';
const MARKER_KEY = 'atlas:test:isolation-marker';
const HOLD_MS = 300;

export function describeIsolationProbe(label: string): void {
  describe(`Isolation between test files (API-100-13 AC1): ${label}`, () => {
    let client: Client;
    let redis: Redis;

    beforeAll(async () => {
      client = await openTestClient();
      redis = new Redis(process.env.REDIS_URL!);
    });

    afterAll(async () => {
      await client.end();
      redis.disconnect();
    });

    it('sees no committed row or Redis key from another test file', async () => {
      const before = await client.query(
        'select key from public.idempotency_keys where user_id = $1',
        [MARKER_USER],
      );
      expect(before.rows).toEqual([]);
      expect(await redis.get(MARKER_KEY)).toBeNull();

      const key = randomUUID();
      await client.query(
        `insert into public.idempotency_keys
           (user_id, key, method, path, request_hash, status, expires_at)
         values ($1, $2, 'POST', '/probe', 'h', 'in_progress', now() + interval '1 hour')`,
        [MARKER_USER, key],
      );
      await redis.set(MARKER_KEY, key);
      await new Promise((resolve) => setTimeout(resolve, HOLD_MS));

      const after = await client.query<{ key: string }>(
        'select key from public.idempotency_keys where user_id = $1',
        [MARKER_USER],
      );
      expect(after.rows).toEqual([{ key }]);
      expect(await redis.get(MARKER_KEY)).toBe(key);
    });
  });
}

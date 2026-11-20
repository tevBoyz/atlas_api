import { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { REDIS_CONNECT_TIMEOUT_MS, REDIS_MAX_RECONNECT_DELAY_MS } from '../redis/redis.service';

/**
 * The two Redis connections of the Socket.IO Redis adapter (API-100-39 AC1): a publisher and a
 * subscriber (a subscribed connection can run no other command). Separate from the API's main client
 * (`RedisService`), which keeps its own settings.
 *
 * - Publisher: no offline queue, so a broadcast while Redis is down fails at once instead of piling up
 *   and flooding clients with stale events later. The adapter does not handle a failed publish, so
 *   {@link AdapterRedis.publisher} wraps `publish` to log it (once per outage) instead of leaving an
 *   unhandled rejection. Local sockets still get the event; other instances miss it (clients re-fetch
 *   over REST after a reconnect anyway, API-100-43).
 * - Subscriber: keeps the offline queue (the adapter subscribes before the connection is up) and
 *   re-subscribes after a reconnect (ioredis `autoResubscribe`).
 *
 * Both reconnect in the background like the main client; loss is logged once (warn), recovery once
 * (info). Readiness (`/readyz` check `realtime`) needs both up.
 */
export class AdapterRedis {
  readonly publisher: Redis;
  readonly subscriber: Redis;
  private readonly raw: Redis;
  private down = { publisher: false, subscriber: false };
  private publishFailing = false;

  constructor(
    url: string,
    private readonly logger: Logger,
  ) {
    const common = {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      retryStrategy: (attempt: number) => Math.min(attempt * 200, REDIS_MAX_RECONNECT_DELAY_MS),
      lazyConnect: true,
    };
    this.raw = new Redis(url, {
      ...common,
      enableOfflineQueue: false,
      connectionName: 'atlas-api-realtime-pub',
    });
    this.subscriber = new Redis(url, {
      ...common,
      connectionName: 'atlas-api-realtime-sub',
    });
    this.watch(this.raw, 'publisher');
    this.watch(this.subscriber, 'subscriber');
    this.publisher = this.safePublisher(this.raw);
  }

  /** Starts both connections. Never rejects: a down Redis must not block startup. */
  connect(): void {
    this.raw.connect().catch(() => undefined);
    this.subscriber.connect().catch(() => undefined);
  }

  /** Readiness: the publisher answers PING and the subscriber is connected. */
  async ping(): Promise<void> {
    if (this.subscriber.status !== 'ready') throw new Error('subscriber not connected');
    const reply = await this.raw.ping();
    if (reply !== 'PONG') throw new Error('unexpected PING reply');
  }

  async close(): Promise<void> {
    await Promise.all([quit(this.raw), quit(this.subscriber)]);
  }

  private watch(client: Redis, role: 'publisher' | 'subscriber'): void {
    client.on('error', (err: Error) => {
      if (this.down[role]) return;
      this.down[role] = true;
      this.logger.warn({ err, role }, 'realtime redis unavailable, reconnecting in the background');
    });
    client.on('ready', () => {
      if (this.down[role]) this.logger.info({ role }, 'realtime redis connection restored');
      this.down[role] = false;
    });
  }

  /** `client` whose `publish` never rejects (a failure is logged once per outage). */
  private safePublisher(client: Redis): Redis {
    const onPublished = () => {
      if (this.publishFailing) this.logger.info('realtime broadcasts to other instances restored');
      this.publishFailing = false;
    };
    const onFailed = (err: unknown) => {
      if (!this.publishFailing) {
        this.logger.warn({ err }, 'realtime broadcast to other instances failed');
      }
      this.publishFailing = true;
      return 0;
    };
    return new Proxy(client, {
      get(target, property) {
        if (property === 'publish') {
          return (...args: Parameters<Redis['publish']>) =>
            target.publish(...args).then((count) => {
              onPublished();
              return count;
            }, onFailed);
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }
}

async function quit(client: Redis): Promise<void> {
  if (client.status === 'ready') {
    try {
      await client.quit();
      return;
    } catch {
      // fall through to a hard disconnect
    }
  }
  client.disconnect();
}

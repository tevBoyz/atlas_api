import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Logger } from 'pino';
import { type Namespace, Server } from 'socket.io';

import { ApiConfigService } from '../config';
import { ROOT_LOGGER } from '../observability/logger';
import { AdapterRedis } from './adapter-redis';
import type { RealtimeEmitter } from './realtime-emitter';
import { REALTIME_NAMESPACE } from './realtime.constants';

/**
 * The worker process's way to reach sockets (SCRUM-63, D62): a Socket.IO server that is never
 * attached to an HTTP server (no client can connect to it), with the same Redis adapter and key
 * (`REALTIME_ADAPTER_KEY`) as the API's gateway. An emit is published through Redis like any
 * cross-instance broadcast, and every API instance delivers it to its own sockets in those rooms.
 *
 * Without REDIS_URL there is nothing to publish to: emits are dropped (development/test only), as the
 * gateway does without an HTTP server. A down Redis loses the emit (logged once by the publisher);
 * clients re-fetch over REST after a reconnect anyway (API-100-43).
 */
@Injectable()
export class WorkerRealtimeEmitter
  implements RealtimeEmitter, OnApplicationBootstrap, OnModuleDestroy
{
  private io?: Server;
  private nsp?: Namespace;
  private redis?: AdapterRedis;

  constructor(
    private readonly config: ApiConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const url = this.config.get('REDIS_URL');
    if (!url) return;
    this.redis = new AdapterRedis(url, this.logger);
    this.redis.connect();
    this.io = new Server({
      serveClient: false,
      adapter: createAdapter(this.redis.publisher, this.redis.subscriber, {
        key: this.config.get('REALTIME_ADAPTER_KEY'),
      }),
    });
    this.nsp = this.io.of(REALTIME_NAMESPACE);
  }

  /** Readiness of the publisher (tests): resolves once Redis answers PING. */
  async ping(): Promise<void> {
    if (!this.redis) throw new Error('REDIS_URL is not set');
    await this.redis.ping();
  }

  emit(rooms: readonly string[], event: string, payload: unknown, except: readonly string[] = []) {
    const nsp = this.nsp;
    if (!nsp || rooms.length === 0) return;
    try {
      let operator = nsp.to([...rooms]);
      if (except.length > 0) operator = operator.except([...except]);
      operator.emit(event, payload);
    } catch (err) {
      this.logger.warn({ err, event, rooms: rooms.length }, 'realtime emit failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    const io = this.io;
    this.io = undefined;
    this.nsp = undefined;
    if (io) {
      for (const nsp of [io.of('/'), io.of(REALTIME_NAMESPACE)]) {
        try {
          await nsp.adapter.close();
        } catch {
          // already closed
        }
      }
      // Never attached to an HTTP server: there is no engine to close.
    }
    await this.redis?.close();
    this.redis = undefined;
  }
}

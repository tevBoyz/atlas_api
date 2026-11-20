import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createAdapter } from '@socket.io/redis-adapter';
import { decodeJwt } from 'jose';
import type { Logger } from 'pino';
import { type Namespace, Server, type Socket } from 'socket.io';

import { MAX_TOKEN_LENGTH } from '../common/auth/bearer';
import {
  TOKEN_VERIFIER,
  TokenRejectedError,
  type TokenVerifier,
} from '../common/auth/token-verifier';
import { ApiConfigService } from '../config';
import { ROOT_LOGGER } from '../observability/logger';
import { AdapterRedis } from './adapter-redis';
import {
  AUTH_UNAVAILABLE_CODE,
  CLIENT_EVENTS,
  incidentResidentRoom,
  incidentRoom,
  incidentUserRoom,
  JOIN_RATE_MAX,
  JOIN_RATE_WINDOW_MS,
  REALTIME_MAX_PACKET_BYTES,
  REALTIME_NAMESPACE,
  REALTIME_PATH,
  SERVER_EVENTS,
  SESSION_EXPIRED_CODE,
  userRoom,
} from './realtime.constants';
import { type IncidentRole, RealtimeAccessRepository } from './realtime-access.repository';
import { RevocationLog } from './revocation-log';

/** What the handshake stored on an accepted socket. */
interface SocketIdentity {
  user_id: string;
  /** Token `exp` in ms since the epoch. */
  expires_at_ms: number;
}

/** An incident room a socket joined, and as whom. */
interface JoinedIncident {
  circle_id: string | null;
  role: IncidentRole;
}

/** The ack of `incident.join` / `incident.leave`. */
export type RealtimeAck = { ok: true } | { ok: false; error: { code: string } };

/** Server-to-server message (Redis adapter `serverSideEmit`) of a membership end. */
const MEMBERSHIP_REVOKED = 'membership.revoked';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** setTimeout's largest delay (about 24.8 days). */
const MAX_TIMER_MS = 2_147_483_647;

/** An error for `connect_error`: `message` and `data.code` both carry the code. */
function connectError(code: string): Error & { data: { code: string } } {
  return Object.assign(new Error(code), { data: { code } });
}

function ackError(code: string): RealtimeAck {
  return { ok: false, error: { code } };
}

/** The incident id of a join/leave payload `{incident_id}` (lowercase), or undefined. */
export function incidentIdOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const id = (payload as { incident_id?: unknown }).incident_id;
  return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : undefined;
}

/**
 * The realtime gateway (API-100-39, API-100-40): Socket.IO on the API's own HTTP server, namespace
 * `/v1/realtime`, Redis adapter for fan-out across instances.
 *
 * - Handshake `auth: {token}` is verified by the same {@link TokenVerifier} as REST. Missing, invalid
 *   or expired → `connect_error` with `message` and `data.code` = `auth:session_expired`; a token that
 *   could not be checked at all (key server down) → `internal:error` (never a sign-out).
 * - Every accepted socket joins `user:{user_id}` and is disconnected at the token's `exp` (after a
 *   `session.expired` event); the client reconnects with a fresh token.
 * - `incident.join {incident_id}` re-checks access on every call (no cached grant): the resident, or
 *   a member passing `incident.memberView` inside the membership window. Else ack `{ok: false, error:
 *   {code: "get_incident_details:not_found"}}`, as REST hides an incident.
 * - Membership end ({@link revokeMembership}, from the membership post-commit hook) takes the user's
 *   sockets out of every incident room of that circle on every instance at once. A join whose check
 *   overlapped a revocation of the same user and circle is refused ({@link RevocationLog}).
 *
 * Websocket transport only: no long-polling, so no sticky sessions are needed behind a load
 * balancer. Nothing is replayed after a reconnect (no connection state recovery): clients re-fetch
 * over REST (API-100-43).
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, OnModuleDestroy {
  private io?: Server;
  private nsp?: Namespace;
  private redis?: AdapterRedis;
  private readonly joined = new Map<string, Map<string, JoinedIncident>>();
  private readonly joinTimes = new Map<string, number[]>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly revocations = new RevocationLog();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: ApiConfigService,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    private readonly access: RealtimeAccessRepository,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /** The namespace, once the server is attached (undefined before bootstrap and after shutdown). */
  get namespace(): Namespace | undefined {
    return this.nsp;
  }

  /** True when the Redis adapter is in use (REDIS_URL set). */
  get usesRedisAdapter(): boolean {
    return this.redis !== undefined;
  }

  onApplicationBootstrap(): void {
    const httpServer: unknown = this.adapterHost.httpAdapter?.getHttpServer();
    if (!httpServer) return;
    const url = this.config.get('REDIS_URL');
    if (url) {
      this.redis = new AdapterRedis(url, this.logger);
      this.redis.connect();
    }
    this.io = new Server(httpServer, {
      path: REALTIME_PATH,
      serveClient: false,
      transports: ['websocket'],
      maxHttpBufferSize: REALTIME_MAX_PACKET_BYTES,
      ...(this.redis
        ? {
            adapter: createAdapter(this.redis.publisher, this.redis.subscriber, {
              key: this.config.get('REALTIME_ADAPTER_KEY'),
            }),
          }
        : {}),
    });
    // Only `/v1/realtime` exists: the default namespace refuses every connection.
    this.io.of('/').use((_socket, next) => next(connectError('realtime:not_found')));
    const nsp = this.io.of(REALTIME_NAMESPACE);
    nsp.use((socket, next) => {
      void this.authenticate(socket).then(
        () => next(),
        (err: Error) => next(err),
      );
    });
    nsp.on('connection', (socket) => this.onConnection(socket));
    nsp.on(MEMBERSHIP_REVOKED, (message: unknown) => this.onRemoteRevocation(message));
    this.nsp = nsp;
  }

  async onModuleDestroy(): Promise<void> {
    const io = this.io;
    this.io = undefined;
    this.nsp = undefined;
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    if (io) {
      // Local sockets only: other instances keep theirs. The HTTP server is closed by Fastify.
      io.local.disconnectSockets(true);
      io.of(REALTIME_NAMESPACE).local.disconnectSockets(true);
      for (const nsp of [io.of('/'), io.of(REALTIME_NAMESPACE)]) {
        try {
          await nsp.adapter.close();
        } catch {
          // already closed
        }
      }
      io.engine.close();
    }
    await this.redis?.close();
    this.redis = undefined;
  }

  /** Readiness check `realtime` (API-100-39 AC5): the adapter's Redis connections. */
  async ping(): Promise<void> {
    if (!this.redis) throw new Error('REDIS_URL is not set');
    await this.redis.ping();
  }

  /**
   * Emits `event` to every socket in `rooms` (on every instance), except sockets in `except`. A
   * socket in several of the rooms gets it once. Never throws: a failed emit is logged (event and
   * room count only) and the caller carries on.
   */
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

  /**
   * Membership end (API-100-40 AC3): `userId`'s sockets leave every incident room of `circleId` they
   * joined as a member, on this instance now and on the others through the adapter. Never throws.
   */
  revokeMembership(userId: string, circleId: string): void {
    this.applyRevocation(userId, circleId);
    try {
      this.nsp?.serverSideEmit(MEMBERSHIP_REVOKED, { user_id: userId, circle_id: circleId });
    } catch (err) {
      this.logger.warn({ err, circle_id: circleId }, 'realtime revocation broadcast failed');
    }
  }

  private async authenticate(socket: Socket): Promise<void> {
    const token: unknown = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !COMPACT_JWS.test(token)) {
      throw connectError(SESSION_EXPIRED_CODE);
    }
    let userId: string;
    try {
      userId = (await this.verifier.verify(token)).id;
    } catch (err) {
      if (err instanceof TokenRejectedError) {
        this.logger.debug({ reason: err.reason }, 'realtime handshake token rejected');
        throw connectError(SESSION_EXPIRED_CODE);
      }
      this.logger.warn({ err }, 'realtime handshake token could not be checked');
      throw connectError(AUTH_UNAVAILABLE_CODE);
    }
    // The verifier required `exp`; it allows a clock skew, the socket does not outlive `exp`.
    const exp = decodeJwt(token).exp;
    const expiresAtMs = typeof exp === 'number' ? exp * 1000 : 0;
    if (expiresAtMs <= Date.now()) throw connectError(SESSION_EXPIRED_CODE);
    const identity: SocketIdentity = { user_id: userId, expires_at_ms: expiresAtMs };
    socket.data = identity;
  }

  private onConnection(socket: Socket): void {
    const identity = socket.data as SocketIdentity;
    void socket.join(userRoom(identity.user_id));
    this.joined.set(socket.id, new Map());
    const delay = Math.min(Math.max(identity.expires_at_ms - Date.now(), 0), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      socket.emit(SERVER_EVENTS.sessionExpired, { code: SESSION_EXPIRED_CODE });
      socket.disconnect(true);
    }, delay);
    timer.unref();
    this.expiryTimers.set(socket.id, timer);

    socket.on(CLIENT_EVENTS.join, (payload: unknown, ack?: unknown) => {
      void this.onJoin(socket, identity.user_id, payload).then((reply) => respond(ack, reply));
    });
    socket.on(CLIENT_EVENTS.leave, (payload: unknown, ack?: unknown) => {
      respond(ack, this.onLeave(socket, identity.user_id, payload));
    });
    socket.on('disconnect', () => {
      clearTimeout(this.expiryTimers.get(socket.id));
      this.expiryTimers.delete(socket.id);
      this.joined.delete(socket.id);
      this.joinTimes.delete(socket.id);
    });
  }

  private async onJoin(socket: Socket, userId: string, payload: unknown): Promise<RealtimeAck> {
    const incidentId = incidentIdOf(payload);
    if (!incidentId) return ackError('validation:invalid_request');
    if (!this.allowJoin(socket.id)) return ackError('rate_limit:exceeded');
    const mark = this.revocations.mark();
    let access;
    try {
      access = await this.access.joinAccess(incidentId, userId);
    } catch (err) {
      this.logger.warn({ err }, 'realtime join check failed');
      return ackError('internal:error');
    }
    const notFound = ackError('get_incident_details:not_found');
    if (!access || socket.disconnected) return notFound;
    if (
      access.role === 'member' &&
      access.circle_id !== null &&
      this.revocations.revokedSince(userId, access.circle_id, mark)
    ) {
      return notFound;
    }
    const rooms = [incidentRoom(incidentId), incidentUserRoom(incidentId, userId)];
    if (access.role === 'resident') rooms.push(incidentResidentRoom(incidentId));
    void socket.join(rooms);
    this.joined.get(socket.id)?.set(incidentId, { circle_id: access.circle_id, role: access.role });
    return { ok: true };
  }

  private onLeave(socket: Socket, userId: string, payload: unknown): RealtimeAck {
    const incidentId = incidentIdOf(payload);
    if (!incidentId) return ackError('validation:invalid_request');
    this.leaveIncident(socket, userId, incidentId);
    return { ok: true };
  }

  private leaveIncident(socket: Socket, userId: string, incidentId: string): void {
    for (const room of [
      incidentRoom(incidentId),
      incidentResidentRoom(incidentId),
      incidentUserRoom(incidentId, userId),
    ]) {
      void socket.leave(room);
    }
    this.joined.get(socket.id)?.delete(incidentId);
  }

  /** At most {@link JOIN_RATE_MAX} joins per socket per {@link JOIN_RATE_WINDOW_MS}. */
  private allowJoin(socketId: string): boolean {
    const now = Date.now();
    const recent = (this.joinTimes.get(socketId) ?? []).filter(
      (at) => at > now - JOIN_RATE_WINDOW_MS,
    );
    if (recent.length >= JOIN_RATE_MAX) {
      this.joinTimes.set(socketId, recent);
      return false;
    }
    recent.push(now);
    this.joinTimes.set(socketId, recent);
    return true;
  }

  private onRemoteRevocation(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const { user_id: userId, circle_id: circleId } = message as Record<string, unknown>;
    if (typeof userId !== 'string' || typeof circleId !== 'string') return;
    this.applyRevocation(userId, circleId);
  }

  /** This instance's part of a revocation. */
  private applyRevocation(userId: string, circleId: string): void {
    this.revocations.record(userId, circleId);
    const nsp = this.nsp;
    if (!nsp) return;
    const socketIds = nsp.adapter.rooms.get(userRoom(userId));
    if (!socketIds) return;
    for (const socketId of [...socketIds]) {
      const socket = nsp.sockets.get(socketId);
      const joined = this.joined.get(socketId);
      if (!socket || !joined) continue;
      for (const [incidentId, entry] of [...joined]) {
        if (entry.role === 'member' && entry.circle_id === circleId) {
          this.leaveIncident(socket, userId, incidentId);
        }
      }
    }
  }
}

function respond(ack: unknown, reply: RealtimeAck): void {
  if (typeof ack === 'function') (ack as (reply: RealtimeAck) => void)(reply);
}

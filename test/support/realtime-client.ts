import { io, type Socket } from 'socket.io-client';

import { REALTIME_NAMESPACE, REALTIME_PATH } from '../../src/realtime/realtime.constants';
import type { RealtimeAck } from '../../src/realtime/realtime.gateway';
import { authHeader, type TestTokenOptions } from '../../src/testing/test-tokens';

/**
 * A Socket.IO client of the realtime gateway (API-100-39 to 43) for tests: websocket only, no
 * automatic reconnection, every received event recorded in order.
 */
export interface TestSocket {
  socket: Socket;
  /** Every server event received so far: `[event, payload]`, in arrival order. */
  received: [string, unknown][];
  /** Payloads of `event` received so far. */
  of<T = Record<string, unknown>>(event: string): T[];
  /**
   * Resolves with the oldest payload of `event` not yet returned by `next` (already received, or the
   * next to arrive). Each payload is returned once.
   */
  next<T = Record<string, unknown>>(event: string, timeoutMs?: number): Promise<T>;
  join(incidentId: unknown): Promise<RealtimeAck>;
  leave(incidentId: unknown): Promise<RealtimeAck>;
  close(): void;
}

export interface ConnectOptions extends TestTokenOptions {
  /** Raw handshake `auth` (overrides the minted token). */
  auth?: Record<string, unknown>;
  namespace?: string;
}

/** Rejects with the `connect_error` (its `message` and `data`). */
export async function connectSocket(
  baseUrl: string,
  userId: string,
  options: ConnectOptions = {},
): Promise<TestSocket> {
  const auth = options.auth ?? {
    token: (await authHeader(userId, options)).authorization.slice('Bearer '.length),
  };
  const socket = io(`${baseUrl}${options.namespace ?? REALTIME_NAMESPACE}`, {
    path: REALTIME_PATH,
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 10_000,
    auth,
  });
  const received: [string, unknown][] = [];
  const waiters: { event: string; resolve: (payload: unknown) => void }[] = [];
  /** Payloads of each event not yet returned by next(), oldest first. */
  const unread = new Map<string, unknown[]>();
  socket.onAny((event: string, payload: unknown) => {
    received.push([event, payload]);
    const waiter = waiters.find((w) => w.event === event);
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(payload);
      return;
    }
    unread.set(event, [...(unread.get(event) ?? []), payload]);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err: Error & { data?: unknown }) => {
      socket.close();
      reject(err);
    });
  });
  const ack = (event: string, incidentId: unknown) =>
    socket.timeout(10_000).emitWithAck(event, { incident_id: incidentId }) as Promise<RealtimeAck>;
  return {
    socket,
    received,
    of: <T>(event: string) => received.filter(([name]) => name === event).map(([, p]) => p as T),
    // Gap 60: a generous default; the wait ends as soon as the event arrives.
    next: <T>(event: string, timeoutMs = 30_000) =>
      new Promise<T>((resolve, reject) => {
        const queued = unread.get(event);
        if (queued?.length) {
          resolve(queued.shift() as T);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`no ${event} within ${timeoutMs} ms`)),
          timeoutMs,
        );
        waiters.push({
          event,
          resolve: (payload) => {
            clearTimeout(timer);
            resolve(payload as T);
          },
        });
      }),
    join: (incidentId) => ack('incident.join', incidentId),
    leave: (incidentId) => ack('incident.leave', incidentId),
    close: () => socket.close(),
  };
}

/** The `connect_error` of a refused handshake. */
export async function connectError(
  baseUrl: string,
  userId: string,
  options: ConnectOptions = {},
): Promise<Error & { data?: { code?: string } }> {
  try {
    const client = await connectSocket(baseUrl, userId, options);
    client.close();
  } catch (err) {
    return err as Error & { data?: { code?: string } };
  }
  throw new Error('the handshake was accepted');
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until `check` passes (polling every 25 ms) or fails after `timeoutMs` (generous: the wait
 * ends as soon as it passes, so only a real failure costs the time, gap 60).
 */
export async function eventually(
  check: () => void | Promise<void>,
  timeoutMs = 20_000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() - started > timeoutMs) throw err;
      await sleep(25);
    }
  }
}

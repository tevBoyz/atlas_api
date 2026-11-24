/**
 * What the incident broadcasts need from Socket.IO: emit one event to rooms, on every instance. The
 * API process uses its gateway ({@link RealtimeGateway}); the worker process, which has no HTTP
 * server, uses {@link WorkerRealtimeEmitter} (SCRUM-63, D62: the close sweeper's `incident.closed`).
 */
export interface RealtimeEmitter {
  /**
   * Emits `event` to every socket in `rooms` (on every instance), except sockets in `except`. A
   * socket in several of the rooms gets it once. Never throws.
   */
  emit(rooms: readonly string[], event: string, payload: unknown, except?: readonly string[]): void;
}

/** DI token of the process's {@link RealtimeEmitter}. */
export const REALTIME_EMITTER = Symbol('REALTIME_EMITTER');

import type { Config } from './config/config.schema';

/**
 * What one process runs (API-100-45 AC3, D82):
 * - `http`: the HTTP API only (the default);
 * - `worker`: the BullMQ job workers only (`WORKER=1`);
 * - `http+workers`: both in one process (`RUN_WORKERS=true`, single-process test hosting, D82).
 */
export type ProcessMode = 'http' | 'worker' | 'http+workers';

/**
 * The mode the config selects. `WORKER=1` together with `RUN_WORKERS=true` is refused by the config
 * validation itself (`config.schema.ts`); this throws too, so no caller can start an ambiguous mode.
 */
export function processMode(config: Pick<Config, 'WORKER' | 'RUN_WORKERS'>): ProcessMode {
  if (config.WORKER && config.RUN_WORKERS) {
    throw new Error('WORKER=1 and RUN_WORKERS=true cannot both be set');
  }
  if (config.WORKER) return 'worker';
  return config.RUN_WORKERS ? 'http+workers' : 'http';
}

/** The signals that stop the single process (the ones Render, Docker and a terminal send). */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** The parts of `process` the shutdown handler uses (replaced by fakes in the unit test). */
export interface ShutdownProcess {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  removeListener(signal: ShutdownSignal, listener: () => void): unknown;
  kill(pid: number, signal: ShutdownSignal): unknown;
  exit(code: number): unknown;
  readonly pid: number;
}

/**
 * One shutdown handler for a process that runs several Nest contexts (D82). Nest's own
 * `enableShutdownHooks` cannot be used per context there: the first context to finish re-raises
 * the signal and the process ends while the other is still closing. On the first SIGTERM / SIGINT
 * this runs `close` once (which closes every context, in order), then re-raises the signal with no
 * listener left, exactly as Nest does, so the exit status stays the signal's. If closing fails the
 * process exits with code 1.
 */
export function onShutdownSignal(
  close: () => Promise<void>,
  onError: (error: unknown) => void,
  proc: ShutdownProcess = process,
): void {
  let closing = false;
  const listeners = new Map<ShutdownSignal, () => void>();
  const detach = () => {
    for (const [signal, listener] of listeners) proc.removeListener(signal, listener);
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    const listener = () => {
      if (closing) return;
      closing = true;
      detach();
      close().then(
        () => proc.kill(proc.pid, signal),
        (error: unknown) => {
          onError(error);
          proc.exit(1);
        },
      );
    };
    listeners.set(signal, listener);
    proc.once(signal, listener);
  }
}

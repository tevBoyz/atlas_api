import { ConfigValidationError, parseConfig } from './config/config.schema';
import {
  onShutdownSignal,
  processMode,
  type ShutdownProcess,
  type ShutdownSignal,
} from './process-mode';

/** A fake `process`: records listeners, kills and exits. */
class FakeProcess implements ShutdownProcess {
  readonly pid = 4242;
  readonly listeners = new Map<ShutdownSignal, () => void>();
  readonly kills: ShutdownSignal[] = [];
  readonly exits: number[] = [];

  once(signal: ShutdownSignal, listener: () => void): void {
    this.listeners.set(signal, listener);
  }

  removeListener(signal: ShutdownSignal, listener: () => void): void {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
  }

  kill(pid: number, signal: ShutdownSignal): void {
    expect(pid).toBe(this.pid);
    this.kills.push(signal);
  }

  exit(code: number): void {
    this.exits.push(code);
  }

  emit(signal: ShutdownSignal): void {
    this.listeners.get(signal)?.();
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('process mode (API-100-45 AC3, D82)', () => {
  it.each([
    [{}, 'http'],
    [{ WORKER: '1' }, 'worker'],
    [{ WORKER: 'true', RUN_WORKERS: 'false' }, 'worker'],
    [{ RUN_WORKERS: 'true' }, 'http+workers'],
    [{ WORKER: '0', RUN_WORKERS: 'true' }, 'http+workers'],
    [{ RUN_WORKERS: 'false' }, 'http'],
  ])('%j selects %s', (env, mode) => {
    expect(processMode(parseConfig(env))).toBe(mode);
  });

  it('RUN_WORKERS defaults to false', () => {
    expect(parseConfig({}).RUN_WORKERS).toBe(false);
  });

  it('refuses WORKER=1 together with RUN_WORKERS=true with a clear message', () => {
    let error: unknown;
    try {
      parseConfig({ WORKER: '1', RUN_WORKERS: 'true' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigValidationError);
    const validation = error as ConfigValidationError;
    expect(validation.keys).toEqual(['RUN_WORKERS']);
    expect(validation.message).toContain('RUN_WORKERS: must not be true together with WORKER=1');
  });

  it('processMode itself refuses both flags', () => {
    expect(() => processMode({ WORKER: true, RUN_WORKERS: true })).toThrow(/cannot both be set/);
  });

  it.each(['yes', '1'])(
    'refuses RUN_WORKERS=%j (only true / false, like every other flag)',
    (raw) => {
      expect(() => parseConfig({ RUN_WORKERS: raw })).toThrow(/RUN_WORKERS: must be true or false/);
    },
  );
});

describe('single-process shutdown (D82)', () => {
  it('closes once on the first signal, then re-raises it with no listener left', async () => {
    const proc = new FakeProcess();
    let closes = 0;
    const errors: unknown[] = [];
    onShutdownSignal(
      async () => {
        closes += 1;
        await flush();
      },
      (error) => errors.push(error),
      proc,
    );
    expect([...proc.listeners.keys()]).toEqual(['SIGTERM', 'SIGINT']);
    const sigint = proc.listeners.get('SIGINT');

    proc.emit('SIGTERM');
    sigint?.(); // a second signal while closing does not close again
    expect(proc.listeners.size).toBe(0);
    await flush();
    await flush();

    expect(closes).toBe(1);
    expect(proc.kills).toEqual(['SIGTERM']);
    expect(proc.exits).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('exits with code 1 when closing fails', async () => {
    const proc = new FakeProcess();
    const errors: unknown[] = [];
    const failure = new Error('close failed');
    onShutdownSignal(
      () => Promise.reject(failure),
      (error) => errors.push(error),
      proc,
    );

    proc.emit('SIGINT');
    await flush();

    expect(errors).toEqual([failure]);
    expect(proc.exits).toEqual([1]);
    expect(proc.kills).toEqual([]);
  });
});

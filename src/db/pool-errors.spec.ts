import { EventEmitter } from 'node:events';

import type { Pool } from 'pg';
import type { Logger } from 'pino';

import { guardPoolErrors, summarizePgError } from './pool-errors';

/** Phase 7 gap 1: a pg client error must never be an unhandled 'error' event. */
describe('guardPoolErrors', () => {
  function setup(): { pool: EventEmitter; warn: jest.Mock } {
    const pool = new EventEmitter();
    const warn = jest.fn();
    guardPoolErrors(pool as unknown as Pool, { warn } as unknown as Logger, 'api');
    return { pool, warn };
  }

  it('gives every new client an error listener, so an error on a checked-out client does not throw', () => {
    const { pool, warn } = setup();
    const client = new EventEmitter();
    pool.emit('connect', client);
    // pg-pool removes its own idle listener while a client is checked out: ours is the only one.
    expect(client.listenerCount('error')).toBe(1);

    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(() => client.emit('error', reset)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      { err: { name: 'Error', code: 'ECONNRESET', message: 'read ECONNRESET' }, pool: 'api' },
      'postgres connection lost',
    );
    // The socket end that follows emits again: still handled, logged once.
    expect(() =>
      client.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps a pool error listener (idle client lost)', () => {
    const { pool } = setup();
    expect(pool.listenerCount('error')).toBe(1);
    expect(() => pool.emit('error', new Error('terminated'), new EventEmitter())).not.toThrow();
  });

  it('a client without the guard would crash (the bug)', () => {
    const bare = new EventEmitter();
    expect(() => bare.emit('error', new Error('read ECONNRESET'))).toThrow('read ECONNRESET');
  });
});

describe('summarizePgError', () => {
  it('keeps name, code and message only (no connection details)', () => {
    const err = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
      severity: 'FATAL',
      client: { connectionString: 'postgresql://user:secret@host/db' },
    });
    const summary = summarizePgError(err);
    expect(summary).toEqual({
      name: 'Error',
      code: '57P01',
      message: 'terminating connection due to administrator command',
    });
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('handles non-Error values and caps long messages', () => {
    expect(summarizePgError('boom')).toEqual({ name: 'Error', message: 'boom' });
    expect(summarizePgError(new Error('x'.repeat(500))).message).toHaveLength(200);
  });
});

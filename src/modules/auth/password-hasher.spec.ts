import bcrypt from 'bcryptjs';

import { Argon2PasswordHasher } from './password-hasher';

/**
 * The `PasswordHasher` (API-100-54 AC5, API-100-58 AC2): argon2id PHC strings, bcrypt verification
 * of migrated Supabase hashes, rehash decisions, and no throw on a malformed hash. Passwords here are
 * test-only values built at runtime.
 */
const PASSWORD = ['Correct', 'Horse', '9'].join('');

describe('Argon2PasswordHasher', () => {
  const hasher = new Argon2PasswordHasher();

  it('hashes with argon2id (19 MiB, 2 passes, 1 lane), salted: two hashes differ', async () => {
    const a = await hasher.hash(PASSWORD);
    const b = await hasher.hash(PASSWORD);
    expect(a.algo).toBe('argon2id');
    expect(a.hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(a.hash).not.toBe(b.hash);
    expect(a.hash).not.toContain(PASSWORD);
  });

  it('verifies the right password only', async () => {
    const stored = await hasher.hash(PASSWORD);
    await expect(hasher.verify(PASSWORD, stored)).resolves.toBe(true);
    await expect(hasher.verify(`${PASSWORD}x`, stored)).resolves.toBe(false);
    await expect(hasher.verify('', stored)).resolves.toBe(false);
  });

  it('verifies bcrypt hashes as Supabase Auth stores them ($2a$10$), and asks for a rehash', async () => {
    const stored = { algo: 'bcrypt' as const, hash: await bcrypt.hash(PASSWORD, 10) };
    expect(stored.hash.startsWith('$2')).toBe(true);
    await expect(hasher.verify(PASSWORD, stored)).resolves.toBe(true);
    await expect(hasher.verify('wrong', stored)).resolves.toBe(false);
    expect(hasher.needsRehash(stored)).toBe(true);
    expect(hasher.needsRehash(await hasher.hash(PASSWORD))).toBe(false);
    expect(
      hasher.needsRehash({ algo: 'argon2id', hash: '$argon2id$v=19$m=4096,t=3,p=1$AAAA$BBBB' }),
    ).toBe(true);
  });

  it('a malformed hash never verifies and never throws', async () => {
    await expect(hasher.verify(PASSWORD, { algo: 'argon2id', hash: 'garbage' })).resolves.toBe(
      false,
    );
    await expect(hasher.verify(PASSWORD, { algo: 'bcrypt', hash: '$2a$10$short' })).resolves.toBe(
      false,
    );
  });

  it('burn() takes about as long as a real verification (unknown accounts)', async () => {
    const stored = await hasher.hash(PASSWORD);
    await hasher.burn('x');
    const t0 = performance.now();
    await hasher.verify('x', stored);
    const real = performance.now() - t0;
    const t1 = performance.now();
    await hasher.burn('x');
    const burnt = performance.now() - t1;
    expect(burnt).toBeGreaterThan(real * 0.3);
  });
});

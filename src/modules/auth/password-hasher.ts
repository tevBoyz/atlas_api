import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';

/** Stored hash algorithms (`user_credentials.hash_algo`). */
export type HashAlgorithm = 'argon2id' | 'bcrypt';

export interface StoredHash {
  hash: string;
  algo: HashAlgorithm;
}

/** DI token of the {@link PasswordHasher}. */
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

/**
 * Password hashing behind one interface (API-100-54 AC5): argon2id for every new hash; bcrypt only
 * to verify the hashes of users migrated from Supabase Auth, which are re-hashed to argon2id on
 * their next successful sign-in (API-100-58 AC2). Passwords and hashes never leave this class
 * through a log or an error.
 */
export interface PasswordHasher {
  /** A new argon2id hash (PHC string). */
  hash(password: string): Promise<StoredHash>;
  /** True when `password` matches. False (never throws) for a malformed hash. */
  verify(password: string, stored: StoredHash): Promise<boolean>;
  /** True when `stored` should be replaced by an argon2id hash after a successful sign-in. */
  needsRehash(stored: StoredHash): boolean;
  /**
   * Spends the time of one verification without a stored hash, so an unknown account answers as
   * slowly as a known one (no account enumeration by timing).
   */
  burn(password: string): Promise<void>;
}

/**
 * argon2id parameters (OWASP's first recommended set): 19 MiB, 2 passes, 1 lane, 16-byte salt,
 * 32-byte tag. Node's built-in `crypto.argon2` (Node 24.7+), no native addon.
 */
export const ARGON2_PARAMETERS = { memory: 19_456, passes: 2, parallelism: 1, tagLength: 32 };
const SALT_BYTES = 16;

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const BCRYPT = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
const unb64 = (text: string) => Buffer.from(text, 'base64');

function derive(
  password: string,
  salt: Buffer,
  params: { memory: number; passes: number; parallelism: number; tagLength: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password, 'utf8'),
        nonce: salt,
        memory: params.memory,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength: params.tagLength,
      },
      (error, key) => (error ? reject(error) : resolve(Buffer.from(key))),
    );
  });
}

@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  private dummy?: Promise<StoredHash>;

  async hash(password: string): Promise<StoredHash> {
    const salt = randomBytes(SALT_BYTES);
    const p = ARGON2_PARAMETERS;
    const tag = await derive(password, salt, p);
    return {
      algo: 'argon2id',
      hash: `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(tag)}`,
    };
  }

  async verify(password: string, stored: StoredHash): Promise<boolean> {
    if (stored.algo === 'bcrypt') {
      if (!BCRYPT.test(stored.hash)) return false;
      try {
        return await bcrypt.compare(password, stored.hash);
      } catch {
        return false;
      }
    }
    const match = PHC.exec(stored.hash);
    if (!match) return false;
    const [, memory, passes, parallelism, salt, tag] = match;
    const expected = unb64(tag);
    try {
      const actual = await derive(password, unb64(salt), {
        memory: Number(memory),
        passes: Number(passes),
        parallelism: Number(parallelism),
        tagLength: expected.length,
      });
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  needsRehash(stored: StoredHash): boolean {
    if (stored.algo !== 'argon2id') return true;
    const match = PHC.exec(stored.hash);
    const p = ARGON2_PARAMETERS;
    return (
      !match ||
      Number(match[1]) !== p.memory ||
      Number(match[2]) !== p.passes ||
      Number(match[3]) !== p.parallelism
    );
  }

  async burn(password: string): Promise<void> {
    this.dummy ??= this.hash(randomBytes(24).toString('hex'));
    await this.verify(password, await this.dummy);
  }
}

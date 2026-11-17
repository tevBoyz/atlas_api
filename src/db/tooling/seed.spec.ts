import { SEED_USERS, seedStatements } from './seed';

describe('local seed data (API-100-03)', () => {
  const users = Object.values(SEED_USERS);

  it('uses only reserved fake emails and fictional 555-01xx phone numbers', () => {
    for (const user of users) {
      expect(user.email).toMatch(/^[a-z]+@example\.test$/);
      expect(user.phone).toMatch(/^\+1201555010\d$/);
    }
  });

  it('passes only fake values to the database', () => {
    for (const { values } of seedStatements()) {
      for (const value of values) {
        if (typeof value !== 'string') continue;
        if (value.includes('@')) expect(value).toMatch(/@example\.test$/);
        if (/^\+?\d{10,15}$/.test(value)) expect(value).toMatch(/^\+?1201555010\d$/);
      }
    }
  });

  it('is idempotent and never writes activated_at (the trigger owns it)', () => {
    for (const { sql } of seedStatements()) {
      expect(sql).toMatch(/on conflict \(id\) do nothing/);
      expect(sql).not.toMatch(/activated_at/);
    }
  });
});

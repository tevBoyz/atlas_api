import { MigrationError, parseMigrationFiles, planMigrations } from './migrate';

describe('API migration runner planning (API-100-03)', () => {
  it('orders by number (not text), ignores non-SQL files and derives ids', () => {
    const files = parseMigrationFiles(['0010_b.sql', 'README.md', '0002_a.sql', '0100_c.sql']);
    expect(files.map((f) => f.id)).toEqual(['0002_a', '0010_b', '0100_c']);
  });

  it.each(['01-bad.sql', 'add_table.sql', '0001_Upper.sql', '0001_.sql'])(
    'rejects the badly named file %s',
    (name) => {
      expect(() => parseMigrationFiles([name])).toThrow(MigrationError);
    },
  );

  it('rejects duplicate numbers', () => {
    expect(() => parseMigrationFiles(['0001_a.sql', '1_b.sql'])).toThrow(/Duplicate/);
  });

  it('plans only unapplied files and reports applied ids without a file', () => {
    const files = parseMigrationFiles(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
    const plan = planMigrations(files, ['0001_a', '0000_gone']);
    expect(plan.pending.map((f) => f.id)).toEqual(['0002_b', '0003_c']);
    expect(plan.unknownApplied).toEqual(['0000_gone']);
  });

  it('has nothing to do for an empty migrations folder', () => {
    expect(planMigrations(parseMigrationFiles([]), [])).toEqual({
      pending: [],
      unknownApplied: [],
    });
  });
});

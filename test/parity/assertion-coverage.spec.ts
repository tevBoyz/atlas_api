import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';

import {
  parityTestName,
  paritySpecFile,
  parseSqlAssertions,
  sqlAssertionsOf,
  sqlTestFiles,
} from '../support/sql-assertions';

/**
 * API-100-13 AC5/AC6: every assertion of every SQL behaviour test has a named parity test (a real
 * `it(...)` or, until its endpoint ships, an `it.todo(...)`), and no parity test names an assertion
 * that does not exist. The gate stories rely on this check.
 */
const PARITY_DIR = resolve('test/parity');

/** The titles of every `it(...)`, `it.todo(...)`, `it.only(...)`, `test(...)` in a spec file. */
function testNamesIn(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2023);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      const title = node.arguments[0];
      if (/^(it|test)(\.\w+)?$/.test(callee) && title && ts.isStringLiteralLike(title)) {
        names.push(title.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

describe('SQL assertion coverage (API-100-13 AC5/AC6)', () => {
  it('finds the 7 SQL files of spec §14.3', () => {
    expect(sqlTestFiles()).toEqual([
      'member_names_expired_invites.sql',
      'membership_access_window.sql',
      'scrum28_accept_amendment.sql',
      'scrum29_cancel_invite.sql',
      'scrum36_resident_incident_reads.sql',
      'scrum43_submit_emergency_alert.sql',
      'scrum45_closure_events.sql',
    ]);
  });

  describe.each(sqlTestFiles())('%s', (sqlFile) => {
    const specFile = join(PARITY_DIR, paritySpecFile(sqlFile));
    const expected = sqlAssertionsOf(sqlFile).map(parityTestName);

    it('has a parity spec file', () => {
      expect(existsSync(specFile)).toBe(true);
    });

    it('has at least one assertion', () => {
      expect(expected.length).toBeGreaterThan(0);
    });

    it('names every SQL assertion exactly once, and nothing else', () => {
      const actual = testNamesIn(specFile);
      expect(expected.filter((name) => !actual.includes(name))).toEqual([]);
      expect(actual.filter((name) => !expected.includes(name))).toEqual([]);
      expect(new Set(actual).size).toBe(actual.length);
    });
  });

  describe('assertion parser', () => {
    const SQL = [
      '-- raise exception must not count in a comment',
      "  raise exception 'plain message';",
      "    raise exception 'count was %', n;",
      "  raise exception 'it''s quoted';",
      '  raise exception using',
      "    message = 'file_ok';",
    ].join('\r\n');

    it('reads messages and lines, and skips comments and the _ok sentinel', () => {
      expect(parseSqlAssertions('file.sql', SQL)).toEqual([
        { file: 'file.sql', line: 2, message: 'plain message' },
        { file: 'file.sql', line: 3, message: 'count was %' },
        { file: 'file.sql', line: 4, message: "it's quoted" },
      ]);
    });
  });
});

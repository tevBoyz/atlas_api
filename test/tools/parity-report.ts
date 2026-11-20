import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { parityTestsIn, type ParityTestKind } from '../support/parity-tests';
import { parityTestName, paritySpecFile, sqlAssertionsOf } from '../support/sql-assertions';

/**
 * `npm run parity:report [-- --phase 1|2] [--results <jest.json>] [--out <file.md>]`
 * (API-100-23 AC1, API-100-33 AC1).
 *
 * Generates a phase's parity checklist: one line per SQL assertion of the phase's test files, each
 * mapped to the parity test that reproduces it and that test's result. Without `--results` it runs
 * the parity suite itself (`test:parity`, containers) and reads Jest's JSON report. Prints the
 * checklist (Markdown) and writes it to `--out` when given. Default phase: 1.
 *
 * Fails (exit 1) when an assertion of the phase has no parity test, is declared `it.todo` / `skip` /
 * `only`, or did not pass. Assertions the phase does not own but that a later story completes are
 * listed separately with that story; they only have to exist (as a test or `it.todo`).
 *
 * - Phase 1: the incident files; the membership-trigger assertions of membership_access_window.sql
 *   are deferred to Phase 2.
 * - Phase 2: scrum28_accept_amendment.sql, scrum29_cancel_invite.sql,
 *   member_names_expired_invites.sql and the membership parts of membership_access_window.sql (its
 *   activation-trigger assertions and the remove / leave block). The `complete_profile_setup`
 *   assertions (and the setup owner row, L84) are deferred to API-100-36.
 */

type Result = 'passed' | 'failed' | 'pending' | 'todo' | 'skipped' | 'not run' | 'missing';

interface Line {
  file: string;
  line: number;
  message: string;
  test: string;
  kind: ParityTestKind | 'missing';
  result: Result;
  deferredTo?: string;
}

interface JestReport {
  testResults: {
    name: string;
    assertionResults: { title: string; status: string; ancestorTitles: string[] }[];
  }[];
}

/** How a phase treats one assertion: part of its gate, deferred to a story, or not its business. */
type Scope = { gate: true } | { deferredTo: string } | null;

interface Phase {
  number: 1 | 2;
  title: string;
  /** What the gate assertions are called in the summary ("incident", "circle and invite"). */
  noun: string;
  files: readonly string[];
  scope(file: string, line: number): Scope;
  deferredHeading: string;
  deferredText: string;
}

const MEMBERSHIP_FILE = 'membership_access_window.sql';

/** membership_access_window.sql lines about membership writes (Phase 2), and who completes them. */
const MEMBERSHIP_TRIGGER_LINES: Record<number, string> = {
  84: 'API-100-36 (owner row from complete setup)',
  121: 'API-100-26/27 (pending invite by phone / link)',
  148: 'API-100-30 (accept)',
  189: 'API-100-33 (Phase 2 gate: no client-chosen activated_at, membership.activate)',
  456: 'API-100-30 (decline)',
};

/** membership_access_window.sql lines of the remove / leave block (API-100-32). */
const MEMBERSHIP_END_LINES = [382, 396, 401, 405, 410, 414, 426, 431, 435, 440, 444];

/** Phase 2 assertions that belong to API-100-36 (complete_profile_setup, the setup owner row). */
const PHASE2_DEFERRED: Record<string, Record<number, string>> = {
  'member_names_expired_invites.sql': {
    137: 'API-100-36 (complete_profile_setup)',
    404: 'API-100-36 (complete_profile_setup re-run after decline)',
    418: 'API-100-36 (complete_profile_setup re-run)',
    458: 'API-100-36 (complete_profile_setup re-run at 5/5)',
  },
  [MEMBERSHIP_FILE]: { 84: 'API-100-36 (owner row from complete setup)' },
};

const PHASES: Record<1 | 2, Phase> = {
  1: {
    number: 1,
    title: 'Phase 1 parity checklist (API-100-23 AC1)',
    noun: 'incident',
    files: [
      'scrum43_submit_emergency_alert.sql',
      'scrum36_resident_incident_reads.sql',
      'scrum45_closure_events.sql',
      MEMBERSHIP_FILE,
    ],
    scope: (file, line) => {
      const deferredTo = file === MEMBERSHIP_FILE ? MEMBERSHIP_TRIGGER_LINES[line] : undefined;
      return deferredTo ? { deferredTo } : { gate: true };
    },
    deferredHeading: 'Not incident behaviour: membership-trigger assertions (Phase 2)',
    deferredText:
      'These `membership_access_window.sql` assertions check the `activated_at` trigger on ' +
      'membership writes, which the API gets in Phase 2. They stay `it.todo` until the story named here.',
  },
  2: {
    number: 2,
    title: 'Phase 2 parity checklist (API-100-33 AC1)',
    noun: 'circle and invite',
    files: [
      'scrum28_accept_amendment.sql',
      'scrum29_cancel_invite.sql',
      'member_names_expired_invites.sql',
      MEMBERSHIP_FILE,
    ],
    scope: (file, line) => {
      const deferredTo = PHASE2_DEFERRED[file]?.[line];
      if (deferredTo) return { deferredTo };
      if (file !== MEMBERSHIP_FILE) return { gate: true };
      // membership_access_window.sql: only its membership parts belong to Phase 2.
      return line in MEMBERSHIP_TRIGGER_LINES || MEMBERSHIP_END_LINES.includes(line)
        ? { gate: true }
        : null;
    },
    deferredHeading: 'Deferred to API-100-36 (complete_profile_setup, Phase 3)',
    deferredText:
      'These assertions exercise `complete_profile_setup` (or the owner row it creates). They are ' +
      'not circle and invite routes; they stay `it.todo` until API-100-36.',
  },
};

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** Runs the parity suite with a JSON report; returns the report (whatever the suite's exit code). */
function runParitySuite(): JestReport {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-parity-report-'));
  const out = join(dir, 'parity.json');
  try {
    process.stderr.write('Running the parity suite (npm run test:parity) for the results...\n');
    spawnSync(
      process.execPath,
      [
        '--experimental-vm-modules',
        resolve('node_modules/jest/bin/jest.js'),
        '--config',
        'test/jest-parity.json',
        '--json',
        `--outputFile=${out}`,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    return JSON.parse(readFileSync(out, 'utf8')) as JestReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `<spec file name>|<test title>` → Jest status. */
function resultsByTest(report: JestReport): Map<string, string> {
  const map = new Map<string, string>();
  for (const suite of report.testResults) {
    for (const test of suite.assertionResults) {
      map.set(`${basename(suite.name)}|${test.title}`, test.status);
    }
  }
  return map;
}

function checklist(phase: Phase, results: Map<string, string>): Line[] {
  const lines: Line[] = [];
  for (const file of phase.files) {
    const specFile = paritySpecFile(file);
    const declared = new Map(
      parityTestsIn(resolve('test/parity', specFile)).map((test) => [test.name, test.kind]),
    );
    for (const assertion of sqlAssertionsOf(file)) {
      const scope = phase.scope(file, assertion.line);
      if (scope === null) continue;
      const test = parityTestName(assertion);
      const kind = declared.get(test) ?? 'missing';
      const status = results.get(`${specFile}|${test}`);
      const result: Result =
        kind === 'missing' ? 'missing' : ((status as Result | undefined) ?? 'not run');
      lines.push({
        file,
        line: assertion.line,
        message: assertion.message,
        test,
        kind,
        result,
        deferredTo: 'deferredTo' in scope ? scope.deferredTo : undefined,
      });
    }
  }
  return lines;
}

const isGate = (line: Line) => line.deferredTo === undefined;
const gateOk = (line: Line) => line.kind === 'it' && line.result === 'passed';
const cell = (text: string) => text.replace(/\|/g, '\\|');

function render(phase: Phase, lines: Line[], source: string): string {
  const out: string[] = [];
  const noun = phase.noun[0].toUpperCase() + phase.noun.slice(1);
  out.push(`# ${phase.title}`);
  out.push('');
  out.push(
    `Generated by \`npm run parity:report${phase.number === 1 ? '' : ` -- --phase ${phase.number}`}\` ` +
      `on ${new Date().toISOString().slice(0, 10)} ` +
      `from the SQL test files in \`db/baseline/tests/\` and the parity specs in \`test/parity/\` ` +
      `(results: ${source}). Do not edit by hand.`,
  );
  if (phase.number === 2) {
    out.push('');
    out.push(
      'Scope: every assertion of `scrum28_accept_amendment.sql`, `scrum29_cancel_invite.sql` and ' +
        '`member_names_expired_invites.sql`, and the membership parts of ' +
        '`membership_access_window.sql` (the `activated_at` trigger on membership writes: L84, ' +
        'L121, L148, L189, L456; and the remove / leave block: L382-L444). Its incident ' +
        'assertions are in `docs/phase1_parity_checklist.md`.',
    );
  }
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push(
    `| SQL file | ${noun} assertions | Passing | Not passing | Deferred (${
      phase.number === 1 ? 'Phase 2' : 'API-100-36'
    }) |`,
  );
  out.push('| --- | --- | --- | --- | --- |');
  for (const file of phase.files) {
    const own = lines.filter((line) => line.file === file);
    const gate = own.filter(isGate);
    out.push(
      `| \`${file}\` | ${gate.length} | ${gate.filter(gateOk).length} | ` +
        `${gate.filter((l) => !gateOk(l)).length} | ${own.length - gate.length} |`,
    );
  }
  out.push('');
  for (const file of phase.files) {
    out.push(`## \`${file}\` → \`test/parity/${paritySpecFile(file)}\``);
    out.push('');
    out.push('| Line | SQL assertion | Parity test | Result |');
    out.push('| --- | --- | --- | --- |');
    for (const line of lines.filter((l) => l.file === file && isGate(l))) {
      const result = line.kind === 'it' ? line.result : `${line.kind} (${line.result})`;
      out.push(`| L${line.line} | ${cell(line.message)} | ${cell(line.test)} | ${result} |`);
    }
    out.push('');
  }
  out.push(`## ${phase.deferredHeading}`);
  out.push('');
  out.push(phase.deferredText);
  out.push('');
  out.push('| File | Line | SQL assertion | Parity test | Declared as | Completed by |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const line of lines.filter((l) => !isGate(l))) {
    out.push(
      `| \`${line.file}\` | L${line.line} | ${cell(line.message)} | ${cell(line.test)} | ` +
        `${line.kind} | ${line.deferredTo} |`,
    );
  }
  out.push('');
  return out.join('\n');
}

/** The deferred lines a phase expects to see (so a renumbered SQL file is noticed). */
function expectedDeferred(phase: Phase): { file: string; line: number }[] {
  if (phase.number === 1) {
    return Object.keys(MEMBERSHIP_TRIGGER_LINES).map((line) => ({
      file: MEMBERSHIP_FILE,
      line: Number(line),
    }));
  }
  return Object.entries(PHASE2_DEFERRED).flatMap(([file, map]) =>
    Object.keys(map).map((line) => ({ file, line: Number(line) })),
  );
}

function main(): void {
  const phaseArg = argValue('--phase') ?? '1';
  if (phaseArg !== '1' && phaseArg !== '2') {
    process.stderr.write(`Unknown --phase ${phaseArg} (1 or 2)\n`);
    process.exit(2);
  }
  const phase = PHASES[Number(phaseArg) as 1 | 2];
  const resultsFile = argValue('--results');
  const outFile = argValue('--out');
  const report = resultsFile
    ? (JSON.parse(readFileSync(resultsFile, 'utf8')) as JestReport)
    : runParitySuite();
  const lines = checklist(phase, resultsByTest(report));
  const markdown = render(phase, lines, resultsFile ? `\`${basename(resultsFile)}\`` : 'this run');
  process.stdout.write(`${markdown}\n`);
  if (outFile) writeFileSync(outFile, `${markdown}\n`);

  const failing = lines.filter((line) => isGate(line) && !gateOk(line));
  const missingDeferred = lines.filter((line) => !isGate(line) && line.kind === 'missing');
  const deferredSeen = new Set(lines.filter((l) => !isGate(l)).map((l) => `${l.file}:${l.line}`));
  const deferredGone = expectedDeferred(phase).filter(
    (d) => !deferredSeen.has(`${d.file}:${d.line}`),
  );
  const gateCount = lines.filter(isGate).length;
  if (failing.length > 0 || missingDeferred.length > 0 || deferredGone.length > 0) {
    for (const line of failing) {
      process.stderr.write(
        `NOT PASSING ${line.file} L${line.line}: ${line.kind}, ${line.result}\n`,
      );
    }
    for (const line of missingDeferred) {
      process.stderr.write(`MISSING ${line.file} L${line.line} (deferred assertion)\n`);
    }
    for (const d of deferredGone) {
      process.stderr.write(`${d.file} L${d.line} is no longer an assertion: update the map\n`);
    }
    process.exit(1);
  }
  process.stderr.write(
    `Phase ${phase.number} parity checklist: ${gateCount} ${phase.noun} assertions, all passing, ` +
      `no it.todo; ${deferredSeen.size} assertions deferred (listed separately).\n`,
  );
}

main();

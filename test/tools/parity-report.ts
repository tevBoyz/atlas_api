import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { parityTestsIn, type ParityTestKind } from '../support/parity-tests';
import {
  parityTestName,
  paritySpecFile,
  sqlAssertionsOf,
  sqlTestFiles,
} from '../support/sql-assertions';

/**
 * `npm run parity:report [-- --phase 1|2|3] [--results <jest.json>] [--out <file.md>]`
 * (API-100-23 AC1, API-100-33 AC1, API-100-38).
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
 *   assertions (and the setup owner row, L84) are deferred to API-100-36 (completed in Phase 3).
 * - Phase 3: the `complete_profile_setup` assertions (member_names_expired_invites.sql L137, L404,
 *   L418, L458) and the setup owner row (membership_access_window.sql L84). It also checks EVERY
 *   parity file of EVERY SQL test: no assertion may be missing, `it.todo`, `skip`, `only` or not
 *   passing anywhere (the "zero todos" table).
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

type PhaseNumber = 1 | 2 | 3;

interface Phase {
  number: PhaseNumber;
  title: string;
  /** What the gate assertions are called in the summary ("incident", "circle and invite"). */
  noun: string;
  files: readonly string[];
  scope(file: string, line: number): Scope;
  deferredHeading: string;
  deferredText: string;
  /** Deliberate, decided divergences from the SQL functions in this phase's area (listed, never hidden). */
  divergences?: readonly Divergence[];
}

/**
 * A decided case where the API answers differently from the SQL function on purpose. No SQL test
 * assertion covers it (the parity suite stays green with the SQL answer unchanged); the SQL answer
 * is kept on record by the named integration test, next to the API's.
 */
interface Divergence {
  decision: string;
  case: string;
  sql: string;
  api: string;
  provedBy: string;
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

/** Phase 3 gate assertions: `complete_profile_setup` and the setup owner row (API-100-36). */
const PHASE3_LINES: Record<string, Record<number, string>> = {
  'member_names_expired_invites.sql': {
    137: 'first setup: circle, owner row, contact invite',
    404: 'setup re-run after decline',
    418: 'setup re-run gives a usable invite',
    458: 'setup re-run at 5/5 leaves the row',
  },
  [MEMBERSHIP_FILE]: { 84: 'owner row from setup has activated_at' },
};

const PHASES: Record<PhaseNumber, Phase> = {
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
      'membership writes, which the API got in Phase 2 (and the setup owner row, L84, in Phase 3). ' +
      'They are proved by the story named here.',
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
      'not circle and invite routes: API-100-36 completes them (Phase 3 checklist).',
    divergences: [
      {
        decision: 'D41 (approved by Dawit 2026-11-21)',
        case:
          'Preview or accept of a new invite by a user who holds a FINISHED row of the same circle ' +
          '(declined; canceled after their claim; or an expired pending row they claimed).',
        sql:
          '409 `preview_circle_invite:duplicate_membership` / ' +
          '`accept_circle_invite:duplicate_membership` (the old row keeps `user_id`).',
        api:
          'Releases the finished row (`user_id = null`, the rest kept as history) and claims / ' +
          'accepts the new invite, in one transaction (caller lock, circle, then member rows with ' +
          '`FOR UPDATE NOWAIT` and retry). ' +
          'Live rows unchanged: `active` → `already_member`; a still-valid claimed pending row → ' +
          '`duplicate_membership`.',
        provedBy:
          '`test/int/invites-lookup-preview.int-spec.ts` ("D41 divergence", SQL answer asserted), ' +
          '`test/int/invites-reinvite-d41.int-spec.ts` (SQL answer asserted; flows and races)',
      },
      {
        decision: 'D44 (SCRUM-30/31; approved by Dawit 2026-11-22)',
        case:
          'Remove (`remove_circle_member`) of an ACTIVE member, or leave (`leave_safety_circle`); ' +
          'and rejoining afterwards by a new invite.',
        sql:
          'Deletes the member row (its `incident_deliveries` cascade). A later invite of the same ' +
          'person is a new row.',
        api:
          'Same answer body and codes, same deliveries deleted, but keeps the row as history: ' +
          '`status` `removed` / `left`, `ended_at = now()`, `invite_token = null` (migration 0013). ' +
          'Every API reader ignores it (member lists, capacity, joined circles, incoming invites, ' +
          'token lookups, resend / cancel, incident access). A new link claim / accept releases its ' +
          '`user_id` (D41 extended); a new phone invite (or profile-setup contact) releases its ' +
          '`phone`. Remove of a pending or declined row is still the SQL delete. The SQL-side ' +
          'assertions are unchanged; a retired SQL reader (D42) would list the history row.',
        provedBy:
          '`test/int/circles-remove-leave.int-spec.ts` (SQL vs API with the recorded divergence), ' +
          '`test/int/circles-membership-history-d44.int-spec.ts` (readers, rejoin, incidents), ' +
          '`test/int/phase2-mixed-writers.int-spec.ts` (history rows per mode)',
      },
      {
        decision: 'D47 (gap 16; approved by Dawit 2026-11-23, gap plan)',
        case:
          'Phone invite (incoming list and its claim, preview, accept, decline) for a caller whose ' +
          'phone is only in `public.users` (an API-signup account), or whose confirmed API phone ' +
          'differs from `auth.users.phone`.',
        sql: 'Reads `auth.users.phone` only: an API-signup account (no `auth.users` row) never matches.',
        api:
          'The confirmed `public.users` phone (`phone_confirmed_at` set), else `auth.users.phone`; an ' +
          'unconfirmed API phone never matches. Same normalization; no shape or code change. The ' +
          'parity fixtures hold the same confirmed phone in both tables, so no assertion changed.',
        provedBy:
          '`test/int/invites-api-phone-d47.int-spec.ts`, `test/int/notification-deliveries.int-spec.ts` (SMS address)',
      },
    ],
  },
  3: {
    number: 3,
    title: 'Phase 3 parity checklist (API-100-38)',
    noun: 'profile setup',
    files: ['member_names_expired_invites.sql', MEMBERSHIP_FILE],
    scope: (file, line) => (PHASE3_LINES[file]?.[line] ? { gate: true } : null),
    deferredHeading: 'Deferred',
    deferredText: 'Nothing is deferred: Phase 3 completes the last open parity assertions.',
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

function render(phase: Phase, lines: Line[], source: string, all?: Line[]): string {
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
  if (phase.number === 3) {
    out.push('');
    out.push(
      'Scope: the `complete_profile_setup` assertions of `member_names_expired_invites.sql` (L137, ' +
        'L404, L418, L458), now through `POST /v1/me/profile/complete`, and the setup owner row of ' +
        '`membership_access_window.sql` (L84). The other assertions of these files are in the Phase 1 ' +
        'and Phase 2 checklists. The last section checks every parity file of every SQL test.',
    );
  }
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
    `| SQL file | ${noun} assertions | Passing | Not passing | ${
      phase.number === 3
        ? 'Other phases'
        : `Deferred (${phase.number === 1 ? 'Phase 2' : 'API-100-36'})`
    } |`,
  );
  out.push('| --- | --- | --- | --- | --- |');
  for (const file of phase.files) {
    const own = lines.filter((line) => line.file === file);
    const gate = own.filter(isGate);
    const others =
      phase.number === 3 ? sqlAssertionsOf(file).length - gate.length : own.length - gate.length;
    out.push(
      `| \`${file}\` | ${gate.length} | ${gate.filter(gateOk).length} | ` +
        `${gate.filter((l) => !gateOk(l)).length} | ${others} |`,
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
  if (phase.number !== 3) {
    out.push(`## ${phase.deferredHeading}`);
    out.push('');
    out.push(phase.deferredText);
    out.push('');
    out.push('| File | Line | SQL assertion | Parity test | Declared as | Result | Completed by |');
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const line of lines.filter((l) => !isGate(l))) {
      out.push(
        `| \`${line.file}\` | L${line.line} | ${cell(line.message)} | ${cell(line.test)} | ` +
          `${line.kind} | ${line.result} | ${line.deferredTo} |`,
      );
    }
    out.push('');
  }
  if (phase.divergences && phase.divergences.length > 0) {
    out.push('## Deliberate divergences from the SQL (decided)');
    out.push('');
    out.push(
      'No SQL test assertion covers these cases, so no assertion above changed: each is listed ' +
        'here, and the SQL answer is kept on record next to the API answer by the named test.',
    );
    out.push('');
    out.push('| Decision | Case | SQL function | API | Proved by |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const d of phase.divergences) {
      out.push(
        `| ${cell(d.decision)} | ${cell(d.case)} | ${cell(d.sql)} | ${cell(d.api)} | ${cell(d.provedBy)} |`,
      );
    }
    out.push('');
  }
  if (all) {
    out.push('## Every parity file (zero `it.todo` overall)');
    out.push('');
    out.push(
      'Every assertion of every SQL test in `db/baseline/tests/`, whatever its phase: its parity test ' +
        'must exist, be a plain `it` (no `it.todo`, `skip` or `only`) and pass.',
    );
    out.push('');
    out.push(
      '| SQL file | Assertions | Plain `it` | `it.todo` | `skip` / `only` | Missing | Passing |',
    );
    out.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const file of sqlTestFiles()) {
      const own = all.filter((l) => l.file === file);
      const count = (kind: string) => own.filter((l) => l.kind === kind).length;
      out.push(
        `| \`${file}\` | ${own.length} | ${count('it')} | ${count('todo')} | ` +
          `${count('skip') + count('only')} | ${count('missing')} | ${own.filter(gateOk).length} |`,
      );
    }
    const total = (pred: (l: Line) => boolean) => all.filter(pred).length;
    out.push(
      `| **All** | ${all.length} | ${total((l) => l.kind === 'it')} | ` +
        `${total((l) => l.kind === 'todo')} | ` +
        `${total((l) => l.kind === 'skip' || l.kind === 'only')} | ` +
        `${total((l) => l.kind === 'missing')} | ${total(gateOk)} |`,
    );
    out.push('');
  }
  return out.join('\n');
}

/** Every assertion of every SQL test file, as a gate line (Phase 3's zero-todo check). */
function everyAssertion(results: Map<string, string>): Line[] {
  const everything: Phase = {
    ...PHASES[3],
    files: sqlTestFiles(),
    scope: () => ({ gate: true }),
  };
  return checklist(everything, results);
}

/** The deferred lines a phase expects to see (so a renumbered SQL file is noticed). */
function expectedDeferred(phase: Phase): { file: string; line: number }[] {
  if (phase.number === 3) return [];
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
  if (phaseArg !== '1' && phaseArg !== '2' && phaseArg !== '3') {
    process.stderr.write(`Unknown --phase ${phaseArg} (1, 2 or 3)\n`);
    process.exit(2);
  }
  const phase = PHASES[Number(phaseArg) as PhaseNumber];
  const resultsFile = argValue('--results');
  const outFile = argValue('--out');
  const report = resultsFile
    ? (JSON.parse(readFileSync(resultsFile, 'utf8')) as JestReport)
    : runParitySuite();
  const results = resultsByTest(report);
  const lines = checklist(phase, results);
  const all = phase.number === 3 ? everyAssertion(results) : undefined;
  const markdown = render(
    phase,
    lines,
    resultsFile ? `\`${basename(resultsFile)}\`` : 'this run',
    all,
  );
  process.stdout.write(`${markdown}\n`);
  if (outFile) writeFileSync(outFile, `${markdown}\n`);

  const failing = [...lines, ...(all ?? [])].filter((line) => isGate(line) && !gateOk(line));
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
  if (all) {
    process.stderr.write(
      `Every parity file: ${all.length} assertions in ${sqlTestFiles().length} SQL tests, all ` +
        `plain it and passing; zero it.todo.\n`,
    );
  }
}

main();

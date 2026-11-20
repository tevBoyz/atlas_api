import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Reads the incident error codes of the specification (API-100-23 AC2) from `docs/api_doc.md`, so
 * the gate test checks the codes the spec lists today, not a hand-copied list:
 *
 * - spec §7.4: one table row per RPC; the first cell names the function, the errors cell lists its
 *   codes in backticks. Parenthesised remarks are dropped first (they quote column names such as
 *   `circle_id`, which are not codes).
 * - spec §11.3 E11: `GET /v1/incidents/{id}/events` has no SQL function; its row lists full
 *   `incident_events:<code>` strings.
 */
export const SPEC_FILE = resolve('docs/api_doc.md');

/** The lines of one `###` section, from its heading to the next `##`/`###` heading. */
function sectionLines(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) throw new Error(`spec section not found: ${heading}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{2,3} /.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

function cellsOf(row: string): string[] {
  return (
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      // `\|` is a pipe inside a cell (e.g. `{circle: ...\|null}`), not a column separator.
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim())
  );
}

const withoutRemarks = (cell: string) => cell.replace(/\([^)]*\)/g, '');

/** `fn:code` strings of spec §7.4, in table order (prefix = the RPC name). */
export function specIncidentRpcCodes(markdown: string): string[] {
  const rows = sectionLines(markdown, '### 7.4 Incidents').filter((line) =>
    /^\| `\w+\(/.test(line),
  );
  const codes: string[] = [];
  for (const row of rows) {
    const cells = cellsOf(row);
    const fn = /^`(\w+)\(/.exec(cells[0])?.[1];
    // Columns: RPC | Auth / who | Returns | Errors | Idempotency / notes
    if (!fn || cells.length !== 5) throw new Error(`unexpected §7.4 row: ${row.slice(0, 60)}`);
    for (const match of withoutRemarks(cells[3]).matchAll(/`(\w+)`/g)) {
      codes.push(`${fn}:${match[1]}`);
    }
  }
  return codes;
}

/** `incident_events:*` strings of spec §11.3 row E11. */
export function specIncidentEventsCodes(markdown: string): string[] {
  const row = markdown.split(/\r?\n/).find((line) => line.startsWith('| E11 |'));
  if (!row) throw new Error('spec §11.3 row E11 not found');
  const cells = cellsOf(row);
  // Columns: # | Method + path | Replaces | Request | Response | Errors | Authorization | Tag
  return [...withoutRemarks(cells[5]).matchAll(/`(incident_events:\w+)`/g)].map((m) => m[1]);
}

/** Every incident error code the spec names (§7.4 plus E11), deduplicated, in spec order. */
export function specIncidentErrorCodes(file: string = SPEC_FILE): string[] {
  const markdown = readFileSync(file, 'utf8');
  return [...new Set([...specIncidentRpcCodes(markdown), ...specIncidentEventsCodes(markdown)])];
}

/**
 * Backticked codes of one cell or line, as full `fn:code` strings: `fn:code` is taken as is (and
 * becomes the prefix of what follows), `:code` and a bare `code` get the current prefix. Wildcards
 * (`fn:*`) are skipped.
 */
function codesIn(text: string, prefix: string | undefined): string[] {
  const codes: string[] = [];
  let current = prefix;
  for (const match of withoutRemarks(text).matchAll(/`([^`]+)`/g)) {
    const token = match[1];
    if (!/^[a-z_]*:?[a-z_*]+$/.test(token)) throw new Error(`not a code: ${token}`);
    const colon = token.indexOf(':');
    const fn = colon < 0 ? undefined : token.slice(0, colon);
    const code = colon < 0 ? token : token.slice(colon + 1);
    if (fn) current = fn;
    if (code === '*') continue;
    if (!current) throw new Error(`code without a prefix: ${token}`);
    codes.push(`${current}:${code}`);
  }
  return codes;
}

/** `fn:code` strings of spec §7.2 (owner side): one table row per RPC, errors in the 3rd cell. */
export function specCircleOwnerCodes(markdown: string): string[] {
  const rows = sectionLines(markdown, '### 7.2 Circles and invites (owner side)').filter((line) =>
    /^\| `\w+\(/.test(line),
  );
  const codes: string[] = [];
  for (const row of rows) {
    const cells = cellsOf(row);
    const fn = /^`(\w+)\(/.exec(cells[0])?.[1];
    // Columns: RPC (args) | Returns | Errors (prefix = RPC name) | Notes
    if (!fn || cells.length !== 4) throw new Error(`unexpected §7.2 row: ${row.slice(0, 60)}`);
    codes.push(...codesIn(cells[2], fn));
  }
  return codes;
}

/**
 * `fn:code` strings of spec §7.3 (invitee / member side): one `####` heading per RPC; its codes are
 * the backticked ones after `Errors:` on the same line (none for `lookup_circle_invite`).
 */
export function specCircleInviteeCodes(markdown: string): string[] {
  const lines = sectionLines(markdown, '### 7.3 Circles and invites (invitee / member side)');
  const codes: string[] = [];
  let fn: string | undefined;
  for (const line of lines) {
    const heading = /^#### `(\w+)\(/.exec(line);
    if (heading) {
      fn = heading[1];
      continue;
    }
    const at = line.indexOf('Errors:');
    if (at >= 0 && fn) codes.push(...codesIn(line.slice(at + 'Errors:'.length), fn));
  }
  return codes;
}

/** Full codes named in the errors cell of the spec §11.3 rows C1-C6 and I1-I11. */
export function specCircleEndpointCodes(markdown: string): string[] {
  const codes: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\| [CI]\d+ \|/.test(line)) continue;
    const cells = cellsOf(line);
    // Columns: # | Method + path | Replaces | Request | Response | Errors | Authorization | Tag
    if (cells.length !== 8) throw new Error(`unexpected §11.3 row: ${line.slice(0, 60)}`);
    // Only full codes start a prefix here; a bare word (e.g. a status) is not a code.
    if (!/`[a-z_]+:/.test(cells[5])) continue;
    codes.push(...codesIn(cells[5], undefined));
  }
  return codes;
}

/** Every circle / invite error code the spec names (§7.2, §7.3, §11.3 C/I rows), deduplicated. */
export function specCircleErrorCodes(file: string = SPEC_FILE): string[] {
  const markdown = readFileSync(file, 'utf8');
  return [
    ...new Set([
      ...specCircleOwnerCodes(markdown),
      ...specCircleInviteeCodes(markdown),
      ...specCircleEndpointCodes(markdown),
    ]),
  ];
}

/**
 * `fn:code` strings of spec §7.1 (`complete_profile_setup`): the backticked codes after `Errors:`
 * under its `####` heading.
 */
export function specProfileRpcCodes(markdown: string): string[] {
  const lines = sectionLines(markdown, '### 7.1 Profile');
  const codes: string[] = [];
  let fn: string | undefined;
  for (const line of lines) {
    const heading = /^#### `(\w+)\(/.exec(line);
    if (heading) {
      fn = heading[1];
      continue;
    }
    const at = line.indexOf('Errors:');
    if (at < 0 || !fn) continue;
    // The sentence after the list (`circle_full` is caught) is a remark, not a code of the function.
    const list = line.slice(at + 'Errors:'.length).split('.')[0];
    codes.push(...codesIn(list, fn));
  }
  return codes;
}

/** Full codes named in the errors cell of the spec §11.3 rows P1-P9 (API-100-38). */
export function specProfileEndpointCodes(markdown: string): string[] {
  const codes: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\| P\d+ \| `(GET|PUT|PATCH|POST|DELETE) /.test(line)) continue;
    const cells = cellsOf(line);
    // Columns: # | Method + path | Replaces | Request | Response | Errors | Rule | Tag
    if (cells.length !== 8) throw new Error(`unexpected §11.3 row: ${line.slice(0, 60)}`);
    codes.push(...codesIn(cells[5], undefined));
  }
  return codes;
}

/**
 * Every profile error code the spec names (§7.1 and §11.3 P1-P9), limited to the Phase 3 prefixes
 * (`profiles`, `complete_profile_setup`), deduplicated.
 */
export function specProfileErrorCodes(file: string = SPEC_FILE): string[] {
  const markdown = readFileSync(file, 'utf8');
  return [
    ...new Set(
      [...specProfileRpcCodes(markdown), ...specProfileEndpointCodes(markdown)].filter((code) =>
        /^(profiles|complete_profile_setup):/.test(code),
      ),
    ),
  ];
}

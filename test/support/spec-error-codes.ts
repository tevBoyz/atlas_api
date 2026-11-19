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
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
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

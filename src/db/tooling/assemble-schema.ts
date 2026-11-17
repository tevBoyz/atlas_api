import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Second half of `npm run db:introspect` (API-100-03): turns drizzle-kit's raw introspection
 * (.drizzle-introspect/schema.ts) into the committed src/db/schema.ts. Deterministic, so the
 * committed file can always be regenerated from a freshly baselined local database.
 *
 * Post-processing (each fixes a drizzle-kit pull limitation; the SQL baseline stays the truth):
 * - Drops `pgPolicy(...)` entries: drizzle-kit loses most USING / WITH CHECK expressions, which
 *   would read as "no restriction". RLS is not the API's authorization (that lives in code).
 * - Drops `.op("...")` operator classes: drizzle-kit mislabels them on multi-column indexes, and
 *   every index uses the default class anyway.
 * - Adds the read-only `auth.users` subset the API may read and points FKs at it.
 */

const RAW = resolve('.drizzle-introspect/schema.ts');
const OUT = resolve('src/db/schema.ts');

const HEADER = `/**
 * Drizzle schema of the Atlas database (API-100-03). GENERATED: do not edit by hand.
 * Regenerate from a freshly baselined LOCAL database with \`npm run db:introspect\`.
 *
 * - Source of truth is SQL: db/baseline/ (Supabase migrations) + db/migrations/ (API-owned).
 *   Never use drizzle-kit generate/push; schema changes are plain SQL migrations.
 * - Triggers stay authoritative (updated_at, member capacity -> raw \`circle_full\`,
 *   activated_at). NEVER write \`activatedAt\` on safety_circle_members: the trigger only ignores
 *   client-chosen values for the anon/authenticated roles, and the API role is neither.
 * - RLS policies are intentionally omitted (authorization is enforced in code, AGENTS.md rule 5).
 * - \`authUsers\` is READ-ONLY: Supabase Auth owns auth.users.
 */
`;

const AUTH_USERS = `
const auth = pgSchema('auth');

/** auth.users (Supabase Auth). READ-ONLY subset used by the API (spec §4.1). */
export const authUsers = auth.table('users', {
  id: uuid().primaryKey().notNull(),
  email: varchar({ length: 255 }),
  /** Stored by GoTrue without the leading "+" in some cases: always normalize to E.164. */
  phone: text(),
  emailConfirmedAt: timestamp('email_confirmed_at', { withTimezone: true, mode: 'string' }),
  phoneConfirmedAt: timestamp('phone_confirmed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }),
});
`;

export function assembleSchema(raw: string): string {
  let body = raw.replace(/\r\n/g, '\n');

  const importMatch = /^import \{([^}]*)\} from "drizzle-orm\/pg-core"\n/m.exec(body);
  if (!importMatch) throw new Error('Unexpected drizzle-kit output: pg-core import not found.');
  const names = new Set(
    importMatch[1]
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n.length > 0 && n !== 'pgPolicy'),
  );
  for (const needed of ['pgSchema', 'uuid', 'text', 'timestamp', 'varchar']) names.add(needed);
  const sortedNames = [...names].sort();
  body = body.replace(
    importMatch[0],
    `import { ${sortedNames.join(', ')} } from 'drizzle-orm/pg-core';\n`,
  );

  body = body.replace(/^\tpgPolicy\([\s\S]*?\}\),\n/gm, '');
  body = body.replace(/\.op\("[a-z0-9_]+"\)/g, '');
  body = body.replace(/foreignColumns: \[users\.id\]/g, 'foreignColumns: [authUsers.id]');
  // Extra-config callbacks left empty (policies only) are dropped; unused `table` params removed.
  body = body.replace(/\}, \(table\) => \[\n([\s\S]*?)^\]\);/gm, (_match, entries: string) => {
    if (entries.trim() === '') return '});';
    return `}, (${entries.includes('table.') ? 'table' : ''}) => [\n${entries}]);`;
  });

  if (/pgPolicy|\busers\.id\b/.test(body)) {
    throw new Error('Post-processing left pgPolicy or users.id references behind.');
  }

  const firstTable = body.indexOf('export const ');
  return `${HEADER}${body.slice(0, firstTable).trimEnd()}\n${AUTH_USERS}\n${body.slice(firstTable)}`;
}

if (require.main === module) {
  writeFileSync(OUT, assembleSchema(readFileSync(RAW, 'utf8')), 'utf8');
  process.stdout.write(`Wrote ${OUT} (run prettier next).\n`);
}

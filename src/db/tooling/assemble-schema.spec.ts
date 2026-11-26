import { assembleSchema } from './assemble-schema';

const RAW = `import { pgTable, foreignKey, pgPolicy, uuid, text, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"



export const appConfig = pgTable("app_config", {
\tkey: text().primaryKey().notNull(),
}, (table) => [
\tpgPolicy("app_config_select_authenticated", { as: "permissive", for: "select", to: ["authenticated"], using: sql\`true\` }),
]);

export const profiles = pgTable("profiles", {
\tid: uuid().primaryKey().notNull(),
}, (table) => [
\tindex("profiles_idx").using("btree", table.id.asc().nullsLast().op("uuid_ops")),
\tforeignKey({
\t\t\tcolumns: [table.id],
\t\t\tforeignColumns: [users.id],
\t\t\tname: "profiles_id_fkey"
\t\t}).onDelete("cascade"),
\tpgPolicy("profiles_select_own", { as: "permissive", for: "select", to: ["authenticated"], using: sql\`(EXISTS ( SELECT 1
   FROM x
  WHERE (x.id = auth.uid())))\` }),
]);
`;

describe('assembleSchema (API-100-03)', () => {
  const out = assembleSchema(RAW);

  it('drops RLS policies and operator classes', () => {
    expect(out).not.toContain('pgPolicy');
    expect(out).not.toContain('.op(');
  });

  it('omits foreign keys to the account table and never models auth.users (D76)', () => {
    expect(out).not.toContain('authUsers');
    expect(out).not.toContain('users.id');
    expect(out).not.toContain('foreignKey({');
    expect(out).toContain('index("profiles_idx")');
  });

  it('removes extra-config callbacks left empty', () => {
    expect(out).toContain(
      'export const appConfig = pgTable("app_config", {\n\tkey: text().primaryKey().notNull(),\n});',
    );
  });

  it('starts with the generated-file header', () => {
    expect(
      out.startsWith('/**\n * Drizzle schema of the Atlas database (API-100-03). GENERATED'),
    ).toBe(true);
  });
});

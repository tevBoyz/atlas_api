import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { activeIncidentIdSql } from './circles.repository';
import { endedSql, notEndedSql } from './invite-slots';

const dialect = new PgDialect();
const CALLER = '11111111-1111-4111-8111-111111111111';

describe('active_incident_id of the joined circles (SCRUM-81, D45)', () => {
  const query = dialect.sqlToQuery(activeIncidentIdSql(sql`c.id`, CALLER));

  it('only the circle’s ACTIVE incidents', () => {
    expect(query.sql).toContain('ai_i.circle_id = c.id');
    expect(query.sql).toContain("ai_i.status = 'active'");
  });

  it('only one the caller may open: their own (resident) or within the membership window', () => {
    expect(query.sql).toContain('ai_i.resident_id = ($');
    expect(query.sql).toContain('pc_w.activated_at <= ai_i.activated_at');
    expect(query.sql).toContain("pc_w.status = 'active'");
    expect(query.sql).toContain('ai_i.resident_id is distinct from ($');
    expect(query.params.every((p) => p === CALLER)).toBe(true);
  });

  it('the newest one, a single id', () => {
    expect(query.sql).toMatch(
      /order by ai_i\.activated_at desc nulls last, ai_i\.created_at desc, ai_i\.id desc\s+limit 1/,
    );
  });
});

describe('ended membership statuses (D44)', () => {
  it('ended = removed or left; not ended = anything else', () => {
    expect(dialect.sqlToQuery(endedSql(sql`m.status`)).sql).toBe(
      "(m.status in ('removed', 'left'))",
    );
    expect(dialect.sqlToQuery(notEndedSql(sql`m.status`)).sql).toBe(
      "(m.status not in ('removed', 'left'))",
    );
  });
});

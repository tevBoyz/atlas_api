import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { DatabaseService } from '../../db/database.service';
import {
  INCIDENT_EVENT_TYPES,
  IncidentEventService,
  isKnownIncidentEventType,
  ONCE_PER_INCIDENT_EVENT_TYPES,
  RESIDENT_ONLY_DETAIL_KEYS,
  UnknownIncidentEventTypeError,
} from './incident-events.service';
import type { IncidentTransaction } from './incidents.repository';

const INCIDENT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const dialect = new PgDialect();

function fakeTx(rows: Record<string, unknown>[] = [{ id: 'e1' }]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = {
    execute: jest.fn((query: SQL) => {
      queries.push(dialect.sqlToQuery(query));
      return Promise.resolve({ rows });
    }),
  };
  return { tx: tx as unknown as IncidentTransaction, queries };
}

const service = () => new IncidentEventService({} as DatabaseService);

describe('IncidentEventService (API-100-22)', () => {
  it('AC2: the known types are exactly spec §5.6, and the once-only ones match the unique index', () => {
    expect(Object.keys(INCIDENT_EVENT_TYPES).sort()).toEqual([
      'alert_sent',
      'closure_notified',
      'incident_closed',
      'location_sharing_ended',
      'location_sharing_started',
      'renotified',
      // SCRUM-60/61 (D71): may repeat; migration 0021 widened incident_events_type_allowed.
      'responder_acknowledged',
      'responder_status',
      'safe_recorded',
      // SCRUM-44/59 (D70): may repeat; migration 0020 widened incident_events_type_allowed.
      'status_update',
    ]);
    expect(
      Object.entries(INCIDENT_EVENT_TYPES)
        .filter(([, meta]) => meta.oncePerIncident)
        .map(([type]) => type)
        .sort(),
    ).toEqual([...ONCE_PER_INCIDENT_EVENT_TYPES].sort());
    // The predicate of incident_events_once_per_incident_uidx (baseline 20261023140000), in order.
    const migration = readFileSync(
      resolve('db/baseline/20261023140000_scrum45_incident_events.sql'),
      'utf8',
    );
    const index = /create unique index incident_events_once_per_incident_uidx[\s\S]*?\);/.exec(
      migration,
    )?.[0];
    expect([...(index ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual([
      ...ONCE_PER_INCIDENT_EVENT_TYPES,
    ]);
    expect(RESIDENT_ONLY_DETAIL_KEYS).toEqual(['recipient_ids']);
  });

  it('AC2: an unknown type is refused in code, before any SQL', async () => {
    const { tx } = fakeTx();
    expect(isKnownIncidentEventType('arrived')).toBe(false);
    expect(isKnownIncidentEventType('toString')).toBe(false);
    await expect(
      service().record(tx, INCIDENT_ID, 'arrived' as never, ACTOR_ID),
    ).rejects.toBeInstanceOf(UnknownIncidentEventTypeError);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('AC1: one insert with ON CONFLICT on the once-only index predicate, DO NOTHING', async () => {
    const { tx, queries } = fakeTx();
    const recorded = await service().record(tx, INCIDENT_ID, 'safe_recorded', ACTOR_ID);
    expect(recorded).toEqual({ id: 'e1', incident_id: INCIDENT_ID, event_type: 'safe_recorded' });
    const text = queries[0].sql.replace(/\s+/g, ' ');
    expect(text).toContain(
      'insert into public.incident_events (incident_id, event_type, actor_id, detail)',
    );
    expect(text).toContain(
      "on conflict (incident_id, event_type) where event_type in ('alert_sent', 'location_sharing_started', 'location_sharing_ended', 'safe_recorded', 'incident_closed', 'closure_notified') do nothing",
    );
    expect(text).not.toMatch(/update|delete/i);
    expect(queries[0].params).toEqual([INCIDENT_ID, 'safe_recorded', ACTOR_ID, '{}']);
  });

  it('detail: a JSON object is sent as one jsonb parameter; a SQL expression is inlined', async () => {
    const { tx, queries } = fakeTx();
    await service().record(tx, INCIDENT_ID, 'incident_closed', ACTOR_ID, {
      resolved_reason: 'safe',
    });
    await service().record(
      tx,
      INCIDENT_ID,
      'renotified',
      ACTOR_ID,
      sql`jsonb_build_object('recipient_count', ${3}::int)`,
    );
    expect(queries[0].params[3]).toBe('{"resolved_reason":"safe"}');
    expect(queries[1].sql).toContain("jsonb_build_object('recipient_count', $4::int)");
  });

  it('afterEarlierEvents (D71): stamps clock_timestamp(), so it sorts after this transaction', async () => {
    const { tx, queries } = fakeTx();
    await service().record(
      tx,
      INCIDENT_ID,
      'responder_status',
      ACTOR_ID,
      { status: 'unable' },
      {
        afterEarlierEvents: true,
      },
    );
    await service().record(tx, INCIDENT_ID, 'responder_acknowledged', ACTOR_ID);
    const later = queries[0].sql.replace(/\s+/g, ' ');
    expect(later).toContain(
      'insert into public.incident_events (incident_id, event_type, actor_id, detail, occurred_at)',
    );
    expect(later).toContain("coalesce($4::jsonb, '{}'::jsonb), clock_timestamp())");
    expect(queries[1].sql).not.toContain('clock_timestamp');
  });

  it('a skipped repeat returns undefined and is not handed to the hook', async () => {
    const events = service();
    const { tx } = fakeTx([]);
    expect(await events.record(tx, INCIDENT_ID, 'alert_sent', ACTOR_ID)).toBeUndefined();
    expect(events.drain(tx)).toEqual([]);
  });

  it('drain returns this transaction’s events in insertion order, once', async () => {
    const events = service();
    const a = fakeTx([{ id: 'a1' }]);
    const b = fakeTx([{ id: 'b1' }]);
    await events.record(a.tx, INCIDENT_ID, 'alert_sent', ACTOR_ID);
    await events.record(b.tx, INCIDENT_ID, 'renotified', ACTOR_ID);
    await events.record(a.tx, INCIDENT_ID, 'location_sharing_started', ACTOR_ID);
    expect(events.drain(a.tx).map((e) => e.event_type)).toEqual([
      'alert_sent',
      'location_sharing_started',
    ]);
    expect(events.drain(a.tx)).toEqual([]);
    expect(events.drain(b.tx)).toHaveLength(1);
  });

  it('AC5: no source file of the API updates or deletes incident_events', () => {
    const { execSync } =
      jest.requireActual<typeof import('node:child_process')>('node:child_process');
    const files = execSync('git ls-files src', { encoding: 'utf8' })
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      // Tracked files deleted in the working tree (not committed yet) are skipped.
      .filter((file) => existsSync(resolve(file)));
    const offenders = files.filter((file) =>
      /(update\s+public\.incident_events|delete\s+from\s+public\.incident_events|update\(incidentEvents\)|delete\(incidentEvents\))/i.test(
        readFileSync(resolve(file), 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

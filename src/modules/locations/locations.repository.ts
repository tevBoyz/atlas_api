import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { INCIDENT_SHARED_JSON } from '../incidents/incident-json';
import type { IncidentTransaction } from '../incidents/incidents.repository';
import type { AttachLocationArgs, PostgresInputType } from './location-input';

/** The function's error codes after the conversion of its arguments. */
export type AttachArgumentError = 'invalid_source' | 'invalid_location';

/**
 * The SQL of `attach_incident_location` (final definition: baseline migration 20261023140000) that is
 * not shared with the other incident writes. Arguments arrive as Postgres input text and are cast in
 * Postgres, so every comparison (`NaN` above every number, `-0 = 0`, timestamps at microsecond
 * precision) is the function's own. Coordinates exist only as bound parameters of these statements.
 */
@Injectable()
export class LocationsRepository {
  /**
   * The session settings PostgREST runs the function under on the hosted database (its defaults):
   * a time without an offset is read in UTC, and `01/02/2026` is month first.
   */
  async useInputSettings(tx: IncidentTransaction): Promise<void> {
    await tx.execute(
      sql`select set_config('TimeZone', 'UTC', true), set_config('DateStyle', 'ISO, MDY', true)`,
    );
  }

  /** `pg_input_is_valid(text, type)` of each value, in order. No table is read. */
  async inputValidity(
    tx: IncidentTransaction,
    checks: readonly { text: string; type: PostgresInputType }[],
  ): Promise<boolean[]> {
    if (checks.length === 0) return [];
    const columns = sql.join(
      checks.map(
        (check, index) =>
          sql`pg_input_is_valid(${check.text}::text, ${check.type}::text) as ${sql.raw(`v${index}`)}`,
      ),
      sql`, `,
    );
    const result = await tx.execute<Record<string, boolean>>(sql`select ${columns}`);
    const row = result.rows[0];
    return checks.map((_, index) => row[`v${index}`] === true);
  }

  /**
   * The function's argument checks, in its order, before any lookup: `invalid_source`, then
   * `invalid_location` (unavailable with a value; current/last_known without lat, lng or captured_at,
   * or out of range; current without accuracy; negative accuracy). Null when they all pass. Every
   * argument must already convert (see `inputValidity`). No table is read.
   */
  async checkArguments(
    tx: IncidentTransaction,
    args: AttachLocationArgs,
  ): Promise<AttachArgumentError | null> {
    const src = sql`${args.source}::text`;
    const lat = sql`${args.lat}::double precision`;
    const lng = sql`${args.lng}::double precision`;
    const acc = sql`${args.accuracy}::double precision`;
    const cap = sql`${args.capturedAt}::timestamptz`;
    const result = await tx.execute<{ error: AttachArgumentError | null }>(sql`
      select case
               when ${src} is null
                    or ${src} not in ('current', 'last_known', 'unavailable')
                 then 'invalid_source'
               when ${src} = 'unavailable' then
                 case
                   when ${lat} is not null
                        or ${lng} is not null
                        or ${acc} is not null
                        or ${cap} is not null
                     then 'invalid_location'
                 end
               when ${lat} is null
                    or ${lng} is null
                    or ${cap} is null
                    or ${lat} < -90
                    or ${lat} > 90
                    or ${lng} < -180
                    or ${lng} > 180
                 then 'invalid_location'
               when ${src} = 'current' and ${acc} is null then 'invalid_location'
               when ${acc} is not null and ${acc} < 0 then 'invalid_location'
             end as error`);
    return result.rows[0].error;
  }

  /**
   * The write, after the row lock and the open check. Out-of-order guard (spec rule 34): when the
   * stored and the incoming `location_captured_at` are both set and the incoming one is older, nothing
   * is written and undefined is returned (the caller answers with the current row). Equal or newer
   * overwrite; `unavailable` (no captured_at) always overwrites all five columns. Returns IncidentShared.
   */
  async writeLocation(
    tx: IncidentTransaction,
    incidentId: string,
    args: AttachLocationArgs,
  ): Promise<Record<string, unknown> | undefined> {
    const cap = sql`${args.capturedAt}::timestamptz`;
    const result = await tx.execute<{ body: Record<string, unknown> }>(sql`
      update public.incidents as rec
         set location_source = ${args.source}::text,
             location_lat = ${args.lat}::double precision,
             location_lng = ${args.lng}::double precision,
             location_accuracy_m = ${args.accuracy}::double precision,
             location_captured_at = ${cap}
       where rec.id = ${incidentId}::uuid
         and not (rec.location_captured_at is not null
                  and ${cap} is not null
                  and ${cap} < rec.location_captured_at)
      returning ${INCIDENT_SHARED_JSON} as body`);
    return result.rows[0]?.body;
  }
}

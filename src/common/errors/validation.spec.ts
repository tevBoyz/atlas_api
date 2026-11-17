import { z } from 'zod';

import { DomainError } from './domain-error';
import { ZodValidationPipe } from './validation';

function failure(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
}

describe('ZodValidationPipe (API-100-05 AC4)', () => {
  const schema = z.object({
    location_source: z.enum(['gps', 'network', 'unavailable']),
    location_lat: z.number().optional(),
    nested: z.object({ items: z.array(z.string()) }).optional(),
  });

  it('returns the parsed value on success', () => {
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({ location_source: 'gps', extra: 1 })).toEqual({
      location_source: 'gps',
    });
  });

  it('uses validation:invalid_request with details.field when no parity code is declared', () => {
    const error = failure(() => new ZodValidationPipe(schema).transform({ location_source: 'x' }));
    expect(error.code).toBe('validation:invalid_request');
    expect(error.status).toBe(422);
    expect(error.details).toEqual({ field: 'location_source' });
  });

  it('uses the parity code declared for the failing field', () => {
    const pipe = new ZodValidationPipe(schema, {
      fields: { location_source: 'attach_incident_location:invalid_source' },
    });
    const error = failure(() => pipe.transform({ location_source: 'x' }));
    expect(error.code).toBe('attach_incident_location:invalid_source');
    expect(error.status).toBe(422);
  });

  it('reports only the first issue, in schema order', () => {
    const pipe = new ZodValidationPipe(schema, {
      fields: {
        location_source: 'attach_incident_location:invalid_source',
        location_lat: 'attach_incident_location:invalid_location',
      },
    });
    const error = failure(() => pipe.transform({ location_source: 'x', location_lat: 'y' }));
    expect(error.code).toBe('attach_incident_location:invalid_source');
  });

  it('gives a dotted path for nested fields and maps by the top-level field', () => {
    const pipe = new ZodValidationPipe(schema, {
      fields: { nested: 'invite_circle_members_by_phone:invalid_invites' },
    });
    const error = failure(() =>
      pipe.transform({ location_source: 'gps', nested: { items: ['ok', 3] } }),
    );
    expect(error.details).toEqual({ field: 'nested.items.1' });
    expect(error.code).toBe('invite_circle_members_by_phone:invalid_invites');
  });

  it('uses the fallback code, and the source as field, when the whole value is wrong', () => {
    const pipe = new ZodValidationPipe(schema, {
      fallback: 'invite_circle_members_by_phone:invalid_invites',
    });
    const error = failure(() => pipe.transform('not an object'));
    expect(error.code).toBe('invite_circle_members_by_phone:invalid_invites');
    expect(error.details).toEqual({ field: 'body' });
  });

  it('names a path parameter through rootField', () => {
    const pipe = new ZodValidationPipe(z.uuid(), {}, 'param', 'incident_id');
    expect(failure(() => pipe.transform('nope')).details).toEqual({ field: 'incident_id' });
  });

  it('never echoes the rejected value', () => {
    const error = failure(() =>
      new ZodValidationPipe(schema).transform({ location_source: '+12015550101' }),
    );
    expect(JSON.stringify(error.details)).not.toContain('+12015550101');
    expect(error.message).not.toContain('+12015550101');
  });
});

import { DomainError } from '../../common/errors';
import {
  STATUS_UPDATE_PRESETS,
  type StatusUpdatePreset,
} from '../notifications/channels/channel.types';
import { isPostgresText } from './incident-input';

/** SCRUM-44/59 (D70): the free text of a status update, after trimming (Unicode code points). */
export const STATUS_UPDATE_TEXT_MAX_LENGTH = 250;

/** The validated body of `POST /v1/incidents/{id}/updates`: exactly one of the two. */
export type StatusUpdateInput = { preset: StatusUpdatePreset } | { text: string };

function invalidUpdate(field: 'body' | 'preset' | 'text'): DomainError {
  return new DomainError('incident_updates:invalid_update', { details: { field } });
}

/**
 * The body of `POST /v1/incidents/{id}/updates` (D70). A JSON object with exactly one of:
 * - `preset`: `situation_worsening` or `help_is_here`;
 * - `text`: a string, trimmed (leading and trailing white space), 1 to 250 characters (Unicode code
 *   points) that Postgres can hold (no NUL, no unpaired surrogate).
 * A key whose value is `null` counts as absent (generated clients send unset fields as null); other
 * keys are ignored. Anything else is 422 `incident_updates:invalid_update` with `details.field`
 * (`body`: not an object, neither or both given; else the offending field). The value is never
 * echoed.
 */
export function statusUpdateFromBody(body: unknown): StatusUpdateInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidUpdate('body');
  }
  const { preset, text } = body as Record<string, unknown>;
  const hasPreset = preset !== undefined && preset !== null;
  const hasText = text !== undefined && text !== null;
  if (hasPreset === hasText) throw invalidUpdate('body');
  if (hasPreset) {
    if (!(STATUS_UPDATE_PRESETS as readonly unknown[]).includes(preset)) {
      throw invalidUpdate('preset');
    }
    return { preset: preset as StatusUpdatePreset };
  }
  if (typeof text !== 'string' || !isPostgresText(text)) throw invalidUpdate('text');
  const trimmed = text.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > STATUS_UPDATE_TEXT_MAX_LENGTH) throw invalidUpdate('text');
  return { text: trimmed };
}

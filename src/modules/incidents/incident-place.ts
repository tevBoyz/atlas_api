import { isPostgresText } from './incident-input';

/**
 * Stage 2 [B6] / [B9]: the optional place of an alert, from the app's reverse geocode of the current
 * or last known fix, sent with the SOS (`POST /v1/incidents`) and with a location report
 * (`POST /v1/incidents/{id}/locations`). Never coordinates.
 *
 * Read leniently: a value that is missing or not valid is left out (an SOS or a location fix is
 * never refused because of its place). When present, a value replaces the stored one (latest wins);
 * left out keeps it.
 */
export interface IncidentPlace {
  /** Trimmed, white space collapsed, 1-120 characters. */
  place_name?: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  country_code?: string;
}

/** Longest place name kept (characters, Unicode code points). */
export const PLACE_NAME_MAX = 120;

const CONTROL = /\p{Cc}/u;
const COUNTRY = /^[A-Za-z]{2}$/;

/** The place name to store, or undefined when `value` is not a usable name. */
export function placeNameOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !isPostgresText(value)) return undefined;
  const name = value.replace(/\s+/g, ' ').trim();
  if (!name || CONTROL.test(name) || [...name].length > PLACE_NAME_MAX) return undefined;
  return name;
}

/** The country code to store (uppercase), or undefined when `value` is not two letters. */
export function countryCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim();
  return COUNTRY.test(code) ? code.toUpperCase() : undefined;
}

/** The place keys of a request body (any other key is ignored). */
export function placeFromBody(body: unknown): IncidentPlace {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  const input = body as Record<string, unknown>;
  const place: IncidentPlace = {};
  const name = placeNameOf(input.place_name);
  if (name !== undefined) place.place_name = name;
  const country = countryCodeOf(input.country_code);
  if (country !== undefined) place.country_code = country;
  return place;
}

/** True when the request carried a usable place name or country. */
export function hasPlace(place: IncidentPlace): boolean {
  return place.place_name !== undefined || place.country_code !== undefined;
}

import { scrubString } from '../../observability/scrubber';

/**
 * What may be stored in `audit_log.detail` (API-100-14 AC4): never medical or share fields, tokens,
 * full phone numbers or coordinates. The log is permanent, so this is stricter than the log
 * scrubber: anything doubtful is left out entirely rather than masked. It strips instead of
 * throwing, because a bad `detail` must never fail the action being audited (an SOS, for example).
 */

const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 200;
const MAX_ARRAY_LENGTH = 20;
/** Larger integers could be phone numbers. Fractions could be coordinates. */
const MAX_INTEGER = 9_999_999;

/** Word-level matches on the snake_case key, e.g. `phone`, `contact_phone`, `phones`. */
const FORBIDDEN_KEY_WORDS = new Set([
  // Medical and emergency information
  'blood',
  'allergy',
  'allergies',
  'medical',
  'medication',
  'medications',
  'condition',
  'conditions',
  'diagnosis',
  'emergency',
  'note',
  'notes',
  'dob',
  'birth',
  'gender',
  // What a resident shares
  'share',
  'shared',
  'sharing',
  // Location
  'lat',
  'lng',
  'lon',
  'long',
  'latitude',
  'longitude',
  'coord',
  'coords',
  'coordinate',
  'coordinates',
  'location',
  'geo',
  'address',
  'accuracy',
  // Contact details and names
  'phone',
  'phones',
  'msisdn',
  'mobile',
  'email',
  'emails',
  'name',
  'names',
  // Secrets
  'token',
  'tokens',
  'jwt',
  'secret',
  'secrets',
  'password',
  'passwd',
  'otp',
  'code',
  'authorization',
  'bearer',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'signature',
  'key',
  'apikey',
]);

/** Known-safe keys that contain a forbidden word but hold only an enumerated value. */
const ALLOWED_KEYS = new Set(['location_source', 'error_code']);

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?/g;
/** Seven or more digits, optionally separated: a phone number with or without its `+`. */
const PHONE_LIKE = /\d(?:[\s().-]*\d){6,}/;
/** A decimal with four or more fractional digits, the precision of a coordinate. */
const COORDINATE_LIKE = /-?\d{1,3}\.\d{4,}/;
/** A long unbroken run of token characters: API keys, invite tokens, hashes. */
const OPAQUE_TOKEN = /[A-Za-z0-9_+/=-]{32,}/;

/** `contactPhone` / `Contact-Phone` → `contact_phone`. */
function snakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function isForbiddenKey(key: string): boolean {
  const normalized = snakeCase(key);
  if (ALLOWED_KEYS.has(normalized)) return false;
  return normalized.split('_').some((word) => FORBIDDEN_KEY_WORDS.has(word));
}

function isSafeString(value: string): boolean {
  if (value.length > MAX_STRING_LENGTH) return false;
  // Whatever the log scrubber would change holds a token, email, phone or invite path.
  if (scrubString(value) !== value) return false;
  const withoutIds = value.replace(UUID, '').replace(ISO_TIMESTAMP, '');
  return (
    !PHONE_LIKE.test(withoutIds) &&
    !COORDINATE_LIKE.test(withoutIds) &&
    !OPAQUE_TOKEN.test(withoutIds)
  );
}

const DROP = Symbol('drop');

function clean(value: unknown, path: string, depth: number, stripped: string[]): unknown {
  const drop = () => {
    stripped.push(path);
    return DROP;
  };
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isInteger(value) && Math.abs(value) <= MAX_INTEGER ? value : drop();
  }
  if (typeof value === 'string') return isSafeString(value) ? value : drop();
  if (typeof value !== 'object' || depth >= MAX_DEPTH) return drop();
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) return drop();
    return value
      .map((item, index) => clean(item, `${path}[${index}]`, depth + 1, stripped))
      .filter((item) => item !== DROP);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return drop();
  return cleanObject(value as Record<string, unknown>, path, depth, stripped);
}

function cleanObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  stripped: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = path ? `${path}.${key}` : key;
    if (entry === undefined) continue;
    if (isForbiddenKey(key)) {
      stripped.push(entryPath);
      continue;
    }
    const cleaned = clean(entry, entryPath, depth + 1, stripped);
    if (cleaned !== DROP) out[key] = cleaned;
  }
  return out;
}

export interface SanitizedDetail {
  detail: Record<string, unknown>;
  /** Paths of what was left out (key names only, never values). */
  stripped: string[];
}

/** The storable part of `detail`. The input is not modified. */
export function sanitizeAuditDetail(detail: Record<string, unknown> = {}): SanitizedDetail {
  const stripped: string[] = [];
  return { detail: cleanObject(detail, '', 0, stripped), stripped };
}

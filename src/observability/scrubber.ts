/**
 * Personal-data and secret scrubber (story API-100-06 AC2). Used by the logger and by Sentry
 * `beforeSend`, so both apply the same rules:
 *
 * | Data                                                          | Treatment                     |
 * | ------------------------------------------------------------- | ----------------------------- |
 * | authorization, cookies, tokens, passwords, secrets, OTP codes | `[REDACTED]`                  |
 * | `share_payload`, medical / emergency fields, notes, names     | `[REDACTED]`                  |
 * | emails                                                        | masked: `a***@***.test`       |
 * | phone numbers                                                 | masked: `***01`               |
 * | coordinates (lat / lng)                                       | key omitted                   |
 *
 * Keys are matched case-insensitively with `-` treated as `_` (so `X-Phone` = `x_phone`).
 * Free text (messages, stacks) is scanned for bearer tokens, JWTs, invite tokens in paths,
 * emails and `+`-prefixed phone numbers.
 */

export const REDACTED = '[REDACTED]';

/** Keys removed entirely (coordinates are omitted, not masked). */
const OMIT_KEYS = new Set([
  'lat',
  'lng',
  'lon',
  'long',
  'latitude',
  'longitude',
  'location_lat',
  'location_lng',
  'p_location_lat',
  'p_location_lng',
  'coords',
  'coordinates',
]);

/** Keys whose value is replaced with `[REDACTED]`, whatever it is. */
const REDACT_KEYS = new Set([
  'authorization',
  'proxy_authorization',
  'cookie',
  'cookies',
  'set_cookie',
  'share_payload',
  'invite_url',
  // Medical / emergency information (spec §4.2, §6.5)
  'blood_type',
  'allergies',
  'medical_conditions',
  'emergency_notes',
  'emergency_preferred_language',
  'incident_notes',
  'p_incident_notes',
  'date_of_birth',
  // Names (personal data)
  'full_name',
  'display_name',
  'owner_name',
  'resident_name',
]);

/** Key fragments that mark a secret: any key containing one is redacted. */
const SECRET_KEY_FRAGMENTS = [
  'token',
  'password',
  'passwd',
  'secret',
  'otp',
  'api_key',
  'apikey',
  'private_key',
  'credential',
  'signature',
  'dsn',
];

const PHONE_KEY_FRAGMENT = 'phone';
const EMAIL_KEY_FRAGMENT = 'email';
/** Prefix of every emergency-contact field (`emergency_contact_full_name`, `..._phone`, ...). */
const EMERGENCY_CONTACT_PREFIX = 'emergency_contact_';

const MAX_DEPTH = 12;
/** One-time / verification codes: 6-10 digits (Supabase and Twilio Verify use 6). */
const OTP_PATTERN = /^\s*\d{6,10}\s*$/;

type KeyRule = 'omit' | 'redact' | 'phone' | 'email' | 'otp_code' | 'keep';

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/-/g, '_');
}

function ruleForKey(rawKey: string): KeyRule {
  const key = normalizeKey(rawKey);
  // Boolean share flags (`share_blood_type`, `share_emergency_contact_phone`) are not personal data.
  if (key.startsWith('share_') && key !== 'share_payload') return 'keep';
  if (OMIT_KEYS.has(key)) return 'omit';
  if (REDACT_KEYS.has(key) || key.startsWith(EMERGENCY_CONTACT_PREFIX)) return 'redact';
  if (SECRET_KEY_FRAGMENTS.some((fragment) => key.includes(fragment))) return 'redact';
  if (key.includes(PHONE_KEY_FRAGMENT)) return 'phone';
  if (key.includes(EMAIL_KEY_FRAGMENT)) return 'email';
  if (key === 'code' || key.endsWith('_code')) return 'otp_code';
  return 'keep';
}

/** `+12015550101` → `***01`. Keeps only the last two digits. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length <= 2 ? '***' : `***${digits.slice(-2)}`;
}

/** `ada@example.test` → `a***@***.test`. Keeps the first character and the top-level domain. */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) return '***';
  const first = value.slice(0, 1);
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = dot >= 0 ? domain.slice(dot) : '';
  return `${first}***@***${tld}`;
}

const BEARER_PATTERN = /\b(Bearer|Basic)\s+[^\s,;"']+/gi;
const JWT_PATTERN = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
const INVITE_PATH_PATTERN = /(invites?\/)[A-Za-z0-9_-]{8,}/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** `+` then 7-15 digits, optionally separated by spaces, dots, dashes or parentheses. */
const PHONE_PATTERN = /\+\d(?:[\s().-]*\d){6,14}/g;

/** Scrubs secrets and personal data out of free text. */
export function scrubString(value: string): string {
  return value
    .replace(BEARER_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(INVITE_PATH_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(EMAIL_PATTERN, (match) => maskEmail(match))
    .replace(PHONE_PATTERN, (match) => maskPhone(match));
}

function scrubByRule(rule: Exclude<KeyRule, 'omit' | 'keep'>, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  switch (rule) {
    case 'redact':
      return REDACTED;
    case 'phone':
      return typeof value === 'string' ? maskPhone(value) : REDACTED;
    case 'email':
      return typeof value === 'string' ? maskEmail(value) : REDACTED;
    case 'otp_code':
      // `code` is also used for error codes, SQLSTATEs and HTTP status codes: only values that look
      // like a one-time code (6-10 digits, string or number) are redacted.
      return (typeof value === 'string' || typeof value === 'number') &&
        OTP_PATTERN.test(`${value}`)
        ? REDACTED
        : value;
  }
}

function scrubError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: error.name,
    message: scrubString(error.message),
  };
  if (error.stack) out.stack = scrubString(error.stack);
  for (const [key, value] of Object.entries(error)) {
    if (key in out) continue;
    const scrubbed = scrubEntry(key, value, depth, seen);
    if (scrubbed !== OMIT) out[key] = scrubbed;
  }
  if (error.cause !== undefined) out.cause = scrubAny(error.cause, depth + 1, seen);
  return out;
}

const OMIT = Symbol('omit');

function scrubEntry(key: string, value: unknown, depth: number, seen: WeakSet<object>): unknown {
  const rule = ruleForKey(key);
  if (rule === 'omit') return OMIT;
  if (rule === 'keep') return scrubAny(value, depth + 1, seen);
  return scrubByRule(rule, value);
}

function scrubAny(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (value instanceof Error) return scrubError(value, depth, seen);
    if (value instanceof Date) return value;
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return '[Binary]';
    if (Array.isArray(value)) return value.map((item) => scrubAny(item, depth + 1, seen));
    if (value instanceof Map) {
      return scrubAny(Object.fromEntries(value as Map<unknown, unknown>), depth, seen);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const scrubbed = scrubEntry(key, entry, depth, seen);
      if (scrubbed !== OMIT) out[key] = scrubbed;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Returns a scrubbed deep copy of `value` (the input is never mutated). Errors become plain
 * `{type, message, stack, ...}` objects with scrubbed text.
 */
export function scrub<T>(value: T): T {
  return scrubAny(value, 0, new WeakSet()) as T;
}

import type { ApiConfigService } from '../../config';
import type { ErrorCode } from '../errors/error-codes';

/**
 * What a limit counts:
 * - `ip`: per client address (public routes, rejected authentication);
 * - `user`: per authenticated user;
 * - `user_incident`: per authenticated user per incident (location pings).
 */
export type RateLimitScope = 'ip' | 'user' | 'user_incident';

export interface RateLimitPolicy {
  /** Part of the Redis key: two routes with one policy name share their counter. */
  name: string;
  /** Requests allowed in any sliding window. */
  max: number;
  windowSeconds: number;
  scope: RateLimitScope;
  /** Path parameter holding the incident id for `user_incident`. Default `id`. */
  incidentParam?: string;
  /** Code of the 429. Default `rate_limit:exceeded`; parity operations pass their own. */
  code?: ErrorCode;
}

export const RATE_LIMIT_POLICY_NAMES = [
  'authenticated',
  'public',
  'location_ping',
  'emergency_write',
  'auth_failure',
  'avatar_upload',
] as const;

/** The configurable policies (API-100-11 AC2). */
export type RateLimitPolicyName = (typeof RATE_LIMIT_POLICY_NAMES)[number];

const NAMED_SCOPES: Record<RateLimitPolicyName, RateLimitScope> = {
  authenticated: 'user',
  public: 'ip',
  location_ping: 'user_incident',
  emergency_write: 'user',
  auth_failure: 'ip',
  avatar_upload: 'user',
};

/** A route's `@RateLimit()` argument: a configured policy or one spelled out in full. */
export type RateLimitRule = RateLimitPolicyName | RateLimitPolicy;

export function scopeOfRule(rule: RateLimitRule | undefined): RateLimitScope | undefined {
  if (rule === undefined) return undefined;
  return typeof rule === 'string' ? NAMED_SCOPES[rule] : rule.scope;
}

/** The configured value of a named policy. */
export function namedPolicy(name: RateLimitPolicyName, config: ApiConfigService): RateLimitPolicy {
  const scope = NAMED_SCOPES[name];
  switch (name) {
    case 'authenticated':
      return {
        name,
        scope,
        max: config.get('RATE_LIMIT_AUTHENTICATED_MAX'),
        windowSeconds: config.get('RATE_LIMIT_AUTHENTICATED_WINDOW_SECONDS'),
      };
    case 'public':
      return {
        name,
        scope,
        max: config.get('RATE_LIMIT_PUBLIC_MAX'),
        windowSeconds: config.get('RATE_LIMIT_PUBLIC_WINDOW_SECONDS'),
      };
    case 'location_ping':
      return {
        name,
        scope,
        max: config.get('RATE_LIMIT_LOCATION_PING_MAX'),
        windowSeconds: config.get('RATE_LIMIT_LOCATION_PING_WINDOW_SECONDS'),
      };
    case 'emergency_write':
      return {
        name,
        scope,
        max: config.get('RATE_LIMIT_EMERGENCY_WRITE_MAX'),
        windowSeconds: config.get('RATE_LIMIT_EMERGENCY_WRITE_WINDOW_SECONDS'),
      };
    case 'auth_failure':
      return {
        name,
        scope,
        max: config.get('RATE_LIMIT_AUTH_FAILURE_MAX'),
        windowSeconds: config.get('RATE_LIMIT_AUTH_FAILURE_WINDOW_SECONDS'),
      };
    case 'avatar_upload':
      return {
        name,
        scope,
        max: config.get('RATE_LIMIT_AVATAR_UPLOAD_MAX'),
        windowSeconds: config.get('RATE_LIMIT_AVATAR_UPLOAD_WINDOW_SECONDS'),
      };
  }
}

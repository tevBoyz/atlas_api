import { sql } from 'drizzle-orm';

import type { Database } from '../../db/database.service';
import {
  EMERGENCY_NUMBERS_CONFIG_KEY,
  EMERGENCY_SERVICE_KINDS,
  type EmergencyService,
  type EmergencyServiceKind,
} from './emergency-numbers.schemas';

/** Anything that runs SQL: the pool or an open transaction. */
export type ConfigExecutor = Pick<Database, 'execute'>;

/**
 * The built-in numbers used only when the `app_config` row `emergency_numbers` is missing or is not
 * a JSON object (migration 0016 seeds the same values), so the shortcut never disappears because of
 * a broken row. A row that exists but has no entry for a country gives that country `[]`.
 */
export const DEFAULT_EMERGENCY_NUMBERS: Readonly<Record<string, readonly EmergencyService[]>> = {
  GM: [
    { service: 'ambulance', label: 'Ambulance', number: '116' },
    { service: 'police', label: 'Police', number: '117' },
    { service: 'fire_rescue', label: 'Fire and Rescue', number: '119' },
  ],
};

/** Digits only, with an optional leading `+`: what a `tel:` link can always carry. */
const NUMBER = /^\+?[0-9]{2,15}$/;
const LABEL_MAX = 40;

function isKind(value: unknown): value is EmergencyServiceKind {
  return (EMERGENCY_SERVICE_KINDS as readonly unknown[]).includes(value);
}

/**
 * The services of one country from the stored config value (SCRUM-54, D60): entries that are not
 * `{service, label, number}` with a known service, a non-blank label (at most 40 characters,
 * trimmed) and a valid number are skipped; for a repeated service the first entry wins; the result
 * is in the fixed order ambulance, police, fire_rescue whatever the stored order.
 */
export function emergencyServicesFrom(config: unknown, country: string): EmergencyService[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return [...(DEFAULT_EMERGENCY_NUMBERS[country] ?? [])];
  }
  const entries = (config as Record<string, unknown>)[country];
  if (!Array.isArray(entries)) return [];
  const byKind = new Map<EmergencyServiceKind, EmergencyService>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { service, label, number } = entry as Record<string, unknown>;
    if (!isKind(service) || byKind.has(service)) continue;
    if (typeof label !== 'string' || typeof number !== 'string') continue;
    const cleanLabel = label.trim();
    const cleanNumber = number.trim();
    if (!cleanLabel || cleanLabel.length > LABEL_MAX || !NUMBER.test(cleanNumber)) continue;
    byKind.set(service, { service, label: cleanLabel, number: cleanNumber });
  }
  return EMERGENCY_SERVICE_KINDS.flatMap((kind) => {
    const found = byKind.get(kind);
    return found ? [found] : [];
  });
}

/**
 * Reads `app_config.emergency_numbers` (on every call: a change applies without a restart) and
 * returns the services of `country`.
 */
export async function readEmergencyServices(
  executor: ConfigExecutor,
  country: string,
): Promise<EmergencyService[]> {
  const result = await executor.execute<{ value: unknown }>(sql`
    select c.value from public.app_config c where c.key = ${EMERGENCY_NUMBERS_CONFIG_KEY}`);
  return emergencyServicesFrom(result.rows[0]?.value, country);
}

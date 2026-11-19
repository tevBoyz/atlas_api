import type { z } from 'zod';

const COMPONENT_NAMES = new WeakMap<object, string>();

/**
 * Publishes `schema` once, as `components.schemas.<name>`; every other published schema that contains
 * it (a nullable property, array items) points at it with `$ref`, so the Dart client gets one class.
 * Returns the same schema instance: only that instance is named (`.extend()` etc. make new ones).
 */
export function componentSchema<T extends z.ZodType>(name: string, schema: T): T {
  COMPONENT_NAMES.set(schema, name);
  return schema;
}

/** The component name of a schema instance, if it was published with {@link componentSchema}. */
export function componentNameOf(schema: object): string | undefined {
  return COMPONENT_NAMES.get(schema);
}

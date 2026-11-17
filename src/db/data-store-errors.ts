/** Raised when code needs a data store whose URL is not configured (development/test only). */
export class DataStoreNotConfiguredError extends Error {
  constructor(readonly key: 'DATABASE_URL' | 'REDIS_URL') {
    super(`${key} is not set`);
    this.name = 'DataStoreNotConfiguredError';
  }
}

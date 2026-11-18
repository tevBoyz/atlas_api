/**
 * First import of `cli.ts`: importing the app module validates the environment, so inherited settings
 * (a DATABASE_URL, a production flag) are removed before that happens. The generated document must
 * not depend on the machine it is generated on.
 */
for (const key of Object.keys(process.env)) {
  if (/^(DATABASE_|REDIS_|SUPABASE_|RATE_LIMIT_|OPENAPI_|TRUST_PROXY|ALLOW_REMOTE)/.test(key)) {
    delete process.env[key];
  }
}
process.env.NODE_ENV = 'development';

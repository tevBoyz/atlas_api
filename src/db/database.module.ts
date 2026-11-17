import { Global, Module } from '@nestjs/common';

import { DatabaseService } from './database.service';

/** Provides {@link DatabaseService} (Postgres pool + Drizzle) app-wide (API-100-07). */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}

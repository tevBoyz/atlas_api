import { Module } from '@nestjs/common';

import { CirclesController } from './circles.controller';
import { CirclesRepository } from './circles.repository';
import { CirclesService } from './circles.service';
import { MeCircleController } from './me-circle.controller';

@Module({
  controllers: [MeCircleController, CirclesController],
  providers: [CirclesRepository, CirclesService],
  // The invite stories (API-100-26 to 32) reuse the reads and the shared slot rules (invite-slots.ts).
  exports: [CirclesRepository, CirclesService],
})
export class CirclesModule {}

import { Module } from '@nestjs/common';

import { FEATURE_MODULES } from './modules';
import { ScaffoldController } from './scaffold.controller';

@Module({
  imports: [...FEATURE_MODULES],
  controllers: [ScaffoldController],
})
export class AppModule {}

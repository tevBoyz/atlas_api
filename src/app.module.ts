import { Module } from '@nestjs/common';

import { ApiConfigModule } from './config';
import { FEATURE_MODULES } from './modules';
import { ScaffoldController } from './scaffold.controller';

@Module({
  imports: [ApiConfigModule, ...FEATURE_MODULES],
  controllers: [ScaffoldController],
})
export class AppModule {}

import { Module } from '@nestjs/common';

import { ErrorsModule } from './common/errors';
import { ApiConfigModule } from './config';
import { FEATURE_MODULES } from './modules';
import { ObservabilityModule } from './observability';
import { ScaffoldController } from './scaffold.controller';

@Module({
  imports: [ApiConfigModule, ObservabilityModule, ErrorsModule, ...FEATURE_MODULES],
  controllers: [ScaffoldController],
})
export class AppModule {}

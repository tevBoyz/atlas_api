export { ApiConfigModule } from './api-config.module';
export { ApiConfigService } from './api-config.service';
export { fastifyTrustProxy, loadConfigOrExit } from './bootstrap-config';
export {
  type Config,
  type ConfigKey,
  ConfigValidationError,
  type LogLevel,
  type NodeEnv,
  parseConfig,
  type TrustProxy,
} from './config.schema';

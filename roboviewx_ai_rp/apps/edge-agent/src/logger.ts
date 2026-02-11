import { createLogger, Logger } from '@repo/logger';
import { config } from './config';

export const logger: Logger = createLogger('edge-agent', config.logLevel);

export const createContextLogger = (context: Record<string, any>): Logger => {
  return logger.child(context);
};

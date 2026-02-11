import pino from 'pino';

export const createLogger = (name: string, level: string = 'info') => {
  return pino({
    name,
    level,
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  });
};

export type Logger = ReturnType<typeof createLogger>;

import pino from 'pino';

export function createLogger(level: string) {
  return pino({
    level,
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;

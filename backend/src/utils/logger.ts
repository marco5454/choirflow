import pino from 'pino';

/**
 * Root logger.
 *
 * - Level: from env `LOG_LEVEL` (default `info`). Use `silent` to suppress in tests.
 * - Format: pretty (single-line, coloured) when `NODE_ENV !== 'production'`, otherwise
 *   structured JSON (one event per line) which is what most log shippers expect.
 * - Use `logger.child({ jobId })` (or any other context) to tag related lines without
 *   repeating the field at every call site.
 */
const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  // Pretty in dev, JSON in prod. pino-pretty is a devDependency so we don't ship it.
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
});

export type Logger = typeof logger;

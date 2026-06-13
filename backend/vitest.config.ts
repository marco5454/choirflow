import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * `env.LOG_LEVEL=silent` is applied to `process.env` before any test module
 * imports run, which means our pino logger (configured at import time in
 * `src/utils/logger.ts`) starts up at the silent level. This keeps test
 * output focused on assertion failures rather than informational lines from
 * the worker, runner, splitter, etc.
 */
export default defineConfig({
  test: {
    env: {
      LOG_LEVEL: 'silent',
    },
  },
});

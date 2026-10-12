import { createApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createLogger } from './logger.js';

function start(): Config {
  try {
    return loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

const config = start();
const logger = createLogger(config.LOG_LEVEL);

const server = createApp(logger).listen(config.PORT, (error?: Error) => {
  if (error) {
    logger.error('failed to start', { message: error.message });
    process.exit(1);
  }
  logger.info('listening', { port: config.PORT });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

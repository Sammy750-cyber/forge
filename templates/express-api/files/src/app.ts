import express, { type ErrorRequestHandler, type Express } from 'express';
import helmet from 'helmet';
import type { Logger } from './logger.js';
import { healthRouter } from './routes/health.js';

export function createApp(logger: Logger): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '100kb' }));

  app.use(healthRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Express recognises error handlers by their four parameters, so `_next` must stay.
  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = (error as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'bad_request' });
      return;
    }
    logger.error('unhandled error', { message: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ error: 'internal_error' });
  };
  app.use(onError);

  return app;
}

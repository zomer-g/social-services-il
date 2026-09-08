import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { healthRouter } from './routes/health.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // The SPA and the docs page both load styles inline; the strict default
      // CSP would break them, so it is configured explicitly once the pages exist.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));

  // The read API is public data and is meant to be called from anywhere,
  // including other people's sites. Write routes authenticate by API key.
  app.use('/api', cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));

  app.use('/api', healthRouter);

  const hasBuiltSpa = existsSync(join(PUBLIC_DIR, 'index.html'));
  if (hasBuiltSpa) {
    app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
    // Client-side routing: any non-API path falls through to the SPA shell.
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(PUBLIC_DIR, 'index.html')));
  } else {
    // Without a built front end the health probe still needs a 2xx at /.
    app.get('/', (_req, res) => {
      res.type('text/plain').send('social-services-il API is running. See /api/health.');
    });
  }

  app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[error] unhandled:', err.stack ?? err.message);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { handleMcpRequest } from './mcp.js';
import { openapi } from './openapi.js';
import { adminRouter } from './routes/admin.js';
import { ingestRouter } from './routes/ingest.js';
import { healthRouter } from './routes/health.js';
import { v1Router } from './routes/v1.js';

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

  // The machine-readable contract, served by the instance it describes, so it
  // can never document a version that is not deployed.
  app.get('/api/openapi.json', cors({ origin: '*' }), (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(openapi);
  });

  app.use('/api', healthRouter);
  app.use('/api/v1', v1Router);
  app.use('/api/v1/ingest', ingestRouter);
  app.use('/api/admin', adminRouter);

  // MCP lives outside /api/v1 because it is not a REST resource: it is a
  // JSON-RPC endpoint over the same data, versioned by the protocol itself.
  // GET and DELETE are part of the Streamable HTTP transport, not just POST.
  app.all('/mcp', cors({ origin: '*', exposedHeaders: ['mcp-session-id'], allowedHeaders: ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'authorization'] }), (req, res) => {
    void handleMcpRequest(req, res);
  });

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

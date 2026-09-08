import { Router } from 'express';
import { query } from '@ssil/db';
import { hasDatabase } from '../config.js';

export const healthRouter: Router = Router();

/**
 * Reports database reachability but always answers 200: the platform health
 * probe hits this path, and a degraded database should not roll back a deploy
 * that is otherwise serving traffic. Callers read `status` to tell the two apart.
 */
healthRouter.get('/health', async (_req, res) => {
  const checks: Record<string, string> = { server: 'ok' };

  if (!hasDatabase()) {
    checks['database'] = 'not-configured';
  } else {
    try {
      const { rows } = await query<{ n: number }>('SELECT 1 AS n');
      checks['database'] = rows[0]?.n === 1 ? 'ok' : 'unexpected-response';
    } catch (err) {
      checks['database'] = `error: ${(err as Error).message}`;
    }
  }

  const healthy = Object.values(checks).every((v) => v === 'ok' || v === 'not-configured');
  res.json({ status: healthy ? 'ok' : 'degraded', checks, version: process.env['XHOST_SHA'] ?? 'dev' });
});

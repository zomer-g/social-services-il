import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { query } from '@ssil/db';

/**
 * API keys for writing.
 *
 * A key is shown once, at creation, and only its hash is stored: a leaked
 * database must not hand anyone a working credential. Each writing key belongs
 * to a source, so everything it pushes is attributed there and inherits that
 * source's trust level — which is what decides whether a push publishes
 * directly or waits for a human.
 */

export interface ApiKeyContext {
  id: string;
  name: string;
  scopes: string[];
  sourceId: string | null;
  sourceSlug: string | null;
  trustLevel: number;
  organizationId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: ApiKeyContext;
  }
}

const PREFIX = 'ssil_';

export function mintKey(): { key: string; hash: string; prefix: string } {
  const key = PREFIX + randomBytes(24).toString('base64url');
  return { key, hash: hashKey(key), prefix: key.slice(0, PREFIX.length + 6) };
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Constant-time comparison, so a wrong key cannot be found byte by byte. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireScope(scope: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!presented) {
      res.status(401).json({ error: 'unauthorized', message: 'An API key is required. Send it as: Authorization: Bearer <key>' });
      return;
    }

    const { rows } = await query<{
      id: string;
      name: string;
      key_hash: string;
      scopes: string[];
      source_id: string | null;
      source_slug: string | null;
      trust_level: number | null;
      organization_id: string | null;
      revoked_at: string | null;
    }>(
      `SELECT k.id, k.name, k.key_hash, k.scopes, k.source_id, s.slug AS source_slug,
              s.trust_level, k.organization_id, k.revoked_at
         FROM api_keys k
         LEFT JOIN sources s ON s.id = k.source_id
        WHERE k.key_hash = $1`,
      [hashKey(presented)],
    );

    const row = rows[0];
    if (!row || !sameHash(row.key_hash, hashKey(presented))) {
      res.status(401).json({ error: 'unauthorized', message: 'Unknown API key' });
      return;
    }
    if (row.revoked_at) {
      res.status(401).json({ error: 'key_revoked' });
      return;
    }
    if (!row.scopes.includes(scope)) {
      res.status(403).json({
        error: 'insufficient_scope',
        message: `This key has [${row.scopes.join(', ')}] but the request needs ${scope}`,
      });
      return;
    }

    req.apiKey = {
      id: row.id,
      name: row.name,
      scopes: row.scopes,
      sourceId: row.source_id,
      sourceSlug: row.source_slug,
      trustLevel: row.trust_level ?? 0,
      organizationId: row.organization_id,
    };

    // Best effort: a failure to record use must not fail the request.
    void query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
    next();
  };
}

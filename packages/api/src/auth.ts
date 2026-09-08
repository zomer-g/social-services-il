import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { query } from '@ssil/db';

/**
 * Sign-in for the admin.
 *
 * Google is the identity provider, and access is invitation-only: an unknown
 * account that signs in successfully is still refused. Anyone can obtain a
 * Google account, so authentication alone is not authorisation, and this admin
 * can publish and unpublish a directory that people rely on in emergencies.
 *
 * Sessions are a signed cookie rather than rows in a table. There is nothing in
 * a session worth storing beyond who it is and when it expires, and a stateless
 * cookie means signing in does not depend on the database being writable.
 */

export const authRouter: Router = Router();

const COOKIE = 'ssil_session';
const SESSION_HOURS = 12;

export type Role = 'admin' | 'editor' | 'tagger' | 'org_manager' | 'viewer';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

function secret(): string {
  const value = process.env['SESSION_SECRET'];
  if (!value) throw new Error('SESSION_SECRET is not set');
  return value;
}

export function googleConfigured(): boolean {
  return Boolean(
    process.env['GOOGLE_CLIENT_ID'] && process.env['GOOGLE_CLIENT_SECRET'] && process.env['SESSION_SECRET'],
  );
}

/* ------------------------------------------------------------- signed values */

function sign(payload: string): string {
  const mac = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

function unsign(token: string): string | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const payload = Buffer.from(body, 'base64url').toString();
  const expected = createHmac('sha256', secret()).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return payload;
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function baseUrl(req: Request): string {
  return process.env['PUBLIC_URL'] || `${req.protocol}://${req.get('host')}`;
}

/* -------------------------------------------------------------------- routes */

authRouter.get('/status', (req, res) => {
  res.json({
    google_configured: googleConfigured(),
    signed_in: Boolean(currentUser(req)),
    user: currentUser(req) ?? null,
  });
});

authRouter.get('/google', (req, res) => {
  if (!googleConfigured()) {
    res.status(503).json({
      error: 'sso_not_configured',
      message: 'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET to enable sign-in.',
    });
    return;
  }

  // The state is signed and short-lived, which is what stops a third party from
  // starting a sign-in and having the result land in someone else's browser.
  const state = sign(JSON.stringify({ nonce: randomBytes(12).toString('base64url'), at: Date.now() }));

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', process.env['GOOGLE_CLIENT_ID']!);
  url.searchParams.set('redirect_uri', `${baseUrl(req)}/api/auth/google/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');

  res.redirect(url.toString());
});

authRouter.get('/google/callback', (req, res) => {
  void (async () => {
    if (!googleConfigured()) {
      res.status(503).send('Sign-in is not configured.');
      return;
    }

    const code = String(req.query['code'] ?? '');
    const stateRaw = String(req.query['state'] ?? '');
    const state = unsign(stateRaw);
    if (!code || !state) {
      res.status(400).send('Sign-in failed: the request could not be verified. Please start again.');
      return;
    }
    const { at } = JSON.parse(state) as { at: number };
    if (Date.now() - at > 10 * 60_000) {
      res.status(400).send('Sign-in took too long. Please start again.');
      return;
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env['GOOGLE_CLIENT_ID']!,
        client_secret: process.env['GOOGLE_CLIENT_SECRET']!,
        redirect_uri: `${baseUrl(req)}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      console.error('[error] google token exchange failed:', await tokenRes.text());
      res.status(502).send('Sign-in failed at the identity provider.');
      return;
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { authorization: `Bearer ${access_token}` },
    });
    const profile = (await profileRes.json()) as {
      sub: string;
      email: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };

    if (!profile.email || profile.email_verified === false) {
      res.status(403).send('Your Google account has no verified email address.');
      return;
    }

    const email = profile.email.toLowerCase();

    // Known user, or a pending invitation. Anything else is refused: signing in
    // proves who you are, not that you belong here.
    const existing = await query<{ id: string; email: string; name: string | null; role: Role; active: boolean }>(
      'SELECT id, email, name, role, active FROM users WHERE lower(email) = $1',
      [email],
    );
    let user = existing.rows[0];

    if (!user) {
      const invite = await query<{ id: string; role: Role; organization_id: string | null }>(
        `SELECT id, role, organization_id FROM invites
          WHERE lower(email) = $1 AND accepted_at IS NULL AND expires_at > now()`,
        [email],
      );
      const pending = invite.rows[0];
      if (!pending) {
        res.status(403).send(
          'This account has not been invited. Ask an administrator to invite ' + email + '.',
        );
        return;
      }

      const created = await query<{ id: string; email: string; name: string | null; role: Role; active: boolean }>(
        `INSERT INTO users (email, name, picture_url, google_sub, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, name, role, active`,
        [email, profile.name ?? null, profile.picture ?? null, profile.sub, pending.role],
      );
      user = created.rows[0]!;
      await query('UPDATE invites SET accepted_at = now() WHERE id = $1', [pending.id]);
      if (pending.organization_id) {
        await query(
          `INSERT INTO org_memberships (user_id, organization_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [user.id, pending.organization_id],
        );
      }
    }

    if (!user.active) {
      res.status(403).send('This account has been deactivated.');
      return;
    }

    await query('UPDATE users SET last_login_at = now(), google_sub = COALESCE(google_sub, $2) WHERE id = $1', [
      user.id,
      profile.sub,
    ]);

    const session = sign(
      JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        exp: Date.now() + SESSION_HOURS * 3600_000,
      }),
    );

    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(session)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
    );
    res.redirect('/admin/');
  })().catch((err: Error) => {
    console.error('[error] google callback:', err.stack ?? err.message);
    res.status(500).send('Sign-in failed.');
  });
});

authRouter.post('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

/* --------------------------------------------------------------- middleware */

export function currentUser(req: Request): SessionUser | undefined {
  const raw = readCookie(req, COOKIE);
  if (!raw) return undefined;
  try {
    const payload = unsign(raw);
    if (!payload) return undefined;
    const session = JSON.parse(payload) as SessionUser & { exp: number };
    if (session.exp < Date.now()) return undefined;
    return { id: session.id, email: session.email, name: session.name, role: session.role };
  } catch {
    return undefined;
  }
}

const RANK: Record<Role, number> = { viewer: 0, org_manager: 1, tagger: 2, editor: 3, admin: 4 };

/**
 * Admin access: a signed-in user with sufficient role, or the bootstrap token.
 *
 * The token remains because it is how the first administrator gets invited, and
 * how automated checks run — but it is only accepted when it is actually set,
 * and it never stands in for a user identity in the audit trail.
 */
export function requireRole(minimum: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const token = process.env['ADMIN_TOKEN'];
    if (token) {
      const header = req.get('authorization') ?? '';
      const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (presented && presented.length === token.length && presented === token) {
        req.user = { id: 'bootstrap-token', email: 'token@local', name: 'Bootstrap token', role: 'admin' };
        next();
        return;
      }
    }

    const user = currentUser(req);
    if (!user) {
      res.status(401).json({ error: 'unauthorized', message: 'Sign in to continue.' });
      return;
    }
    if (RANK[user.role] < RANK[minimum]) {
      res.status(403).json({
        error: 'insufficient_role',
        message: `This needs the ${minimum} role; your account has ${user.role}.`,
      });
      return;
    }
    req.user = user;
    next();
  };
}

import { Router, type NextFunction, type Request, type Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query } from '@ssil/db';

/**
 * Sign-in for the admin.
 *
 * Identity comes from the hosting platform's Google sign-in. It mounts itself
 * at /xhost-auth/ on every channel and needs no client id, secret or redirect
 * URI from us — which is worth more than the code it saves: an OAuth client we
 * own is a credential we have to store, rotate and eventually leak.
 *
 * The platform sets a cookie holding a signed JWT and does no enforcement of
 * its own: every request reaches this app whether or not the visitor signed in.
 * Access control is entirely ours, which is the right division — the platform
 * knows who someone is, only we know whether they should be here.
 *
 * Authentication is not authorisation. Anyone can obtain a Google account, so a
 * verified email still has to appear in the allowlist or hold an invitation
 * before it reaches an admin that publishes a directory people rely on in
 * emergencies.
 */

export const authRouter: Router = Router();

const ISSUER = 'https://auth.xhostd.com';
const COOKIE = '__Host-xhost_id';

// Fetched once and cached by jose, which also handles key rotation.
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/xhost-auth/jwks`));

export type Role = 'admin' | 'editor' | 'tagger' | 'org_manager' | 'viewer';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  picture?: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

/**
 * Emails that are administrators regardless of what the database says.
 *
 * This is the bootstrap: without it the first administrator could never sign in
 * to invite themselves. Kept as configuration rather than a row so that losing
 * the database does not lock everyone out.
 */
function allowlist(): string[] {
  return (process.env['ADMIN_EMAILS'] ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
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

export interface Identity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

/**
 * Verifies the platform's identity cookie.
 *
 * The audience is taken from the request's own host rather than hardcoded: a
 * token minted for one channel must not be accepted by another, and a constant
 * here would quietly break that the first time a custom domain is added.
 */
export async function verifyIdentity(req: Request): Promise<Identity | null> {
  const token = readCookie(req, COOKIE);
  if (!token) return null;

  try {
    const host = req.get('host');
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: host,
      // Pinned: never trust the algorithm named in the token's own header.
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iss', 'aud', 'sub', 'email'],
      clockTolerance: 60,
    });

    const email = String(payload['email'] ?? '');
    if (!email) return null;

    return {
      sub: String(payload.sub),
      email,
      name: payload['name'] ? String(payload['name']) : undefined,
      picture: payload['picture'] ? String(payload['picture']) : undefined,
    };
  } catch {
    // Every verification failure is simply "not signed in": an expired token,
    // a forged one and a token for another channel all mean the same here.
    return null;
  }
}

/**
 * Turns a verified identity into a role, or refuses.
 *
 * Three ways in, in order: the allowlist, an existing user row, or a pending
 * invitation, which is redeemed on first sign-in. Anything else is refused —
 * signing in proves who you are, not that you belong here.
 */
export async function resolveUser(identity: Identity): Promise<SessionUser | null> {
  const email = identity.email.toLowerCase();

  const existing = await query<{ id: string; email: string; name: string | null; role: Role; active: boolean }>(
    'SELECT id, email, name, role, active FROM users WHERE lower(email) = $1',
    [email],
  );
  let user = existing.rows[0];

  if (allowlist().includes(email)) {
    if (!user) {
      const created = await query<{ id: string; email: string; name: string | null; role: Role; active: boolean }>(
        `INSERT INTO users (email, name, picture_url, google_sub, role)
         VALUES ($1, $2, $3, $4, 'admin')
         RETURNING id, email, name, role, active`,
        [email, identity.name ?? null, identity.picture ?? null, identity.sub],
      );
      user = created.rows[0]!;
    } else if (user.role !== 'admin') {
      // The allowlist is the stronger statement; a row that says otherwise is
      // out of date rather than authoritative.
      await query(`UPDATE users SET role = 'admin', active = true WHERE id = $1`, [user.id]);
      user = { ...user, role: 'admin', active: true };
    }
  }

  if (!user) {
    const invite = await query<{ id: string; role: Role; organization_id: string | null }>(
      `SELECT id, role, organization_id FROM invites
        WHERE lower(email) = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [email],
    );
    const pending = invite.rows[0];
    if (!pending) return null;

    const created = await query<{ id: string; email: string; name: string | null; role: Role; active: boolean }>(
      `INSERT INTO users (email, name, picture_url, google_sub, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, role, active`,
      [email, identity.name ?? null, identity.picture ?? null, identity.sub, pending.role],
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

  if (!user.active) return null;

  await query(
    'UPDATE users SET last_login_at = now(), google_sub = COALESCE(google_sub, $2) WHERE id = $1',
    [user.id, identity.sub],
  );

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    picture: identity.picture ?? null,
  };
}

/* -------------------------------------------------------------------- routes */

authRouter.get('/status', (req, res) => {
  void (async () => {
    const identity = await verifyIdentity(req);
    const user = identity ? await resolveUser(identity) : null;

    res.json({
      // Provided by the platform, so it is always available here — no client
      // id or secret to configure.
      provider: 'google',
      signed_in: Boolean(identity),
      // Signed in but not permitted is a distinct state, and the difference is
      // the whole message the person needs: ask to be invited, do not retry.
      authorised: Boolean(user),
      email: identity?.email ?? null,
      user,
      login_url: '/xhost-auth/login?return_to=/admin/',
      logout_url: '/xhost-auth/logout?return_to=/',
    });
  })().catch((err: Error) => {
    console.error('[error] auth status:', err.message);
    res.status(500).json({ error: 'internal_error' });
  });
});

/* ---------------------------------------------------------------- middleware */

const RANK: Record<Role, number> = { viewer: 0, org_manager: 1, tagger: 2, editor: 3, admin: 4 };

export function requireRole(minimum: Role) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void (async () => {
      // The bootstrap token remains for automated checks and for recovering
      // access when sign-in is broken. It never stands in for a person in the
      // audit trail.
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

      const identity = await verifyIdentity(req);
      if (!identity) {
        res.status(401).json({
          error: 'unauthorized',
          message: 'יש להתחבר עם חשבון Google.',
          login_url: '/xhost-auth/login?return_to=/admin/',
        });
        return;
      }

      const user = await resolveUser(identity);
      if (!user) {
        res.status(403).json({
          error: 'not_invited',
          message: `החשבון ${identity.email} אינו מורשה. יש לבקש הזמנה ממנהל המערכת.`,
        });
        return;
      }

      if (RANK[user.role] < RANK[minimum]) {
        res.status(403).json({
          error: 'insufficient_role',
          message: `הפעולה דורשת הרשאת ${minimum}; לחשבון שלך יש ${user.role}.`,
        });
        return;
      }

      req.user = user;
      next();
    })().catch((err: Error) => {
      console.error('[error] auth:', err.stack ?? err.message);
      res.status(500).json({ error: 'internal_error' });
    });
  };
}

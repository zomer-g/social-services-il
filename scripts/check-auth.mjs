#!/usr/bin/env node
/**
 * Tries to forge its way into the admin.
 *
 * The admin can unpublish a directory that people rely on in emergencies, so
 * the identity cookie is worth attacking deliberately rather than trusting that
 * the library got it right. Three attempts that a naive verifier accepts:
 * garbage, an alg:none token, and a correctly shaped RS256 token signed with
 * the attacker's own key carrying the right key id.
 *
 *   ADMIN_TOKEN=... node scripts/check-auth.mjs [baseUrl]
 *
 * Run from the repository root so that jose resolves.
 */

import { SignJWT, generateKeyPair } from 'jose';

const BASE = (process.argv[2] ?? 'https://social-services-il-zomerg.xhostd.app').replace(/\/$/, '');
const HOST = new URL(BASE).host;
const COOKIE = '__Host-xhost_id';

const probe = async (label, token) => {
  const res = await fetch(`${BASE}/api/admin/overview`, {
    headers: { cookie: `${COOKIE}=${token}` },
  });
  const body = await res.json().catch(() => ({}));
  const refused = res.status === 401 || res.status === 403;
  console.log(`  ${refused ? 'REFUSED' : '*** ACCEPTED ***'}  ${label}  [${res.status}] ${body.error ?? ''}`);
  return refused;
};

let allRefused = true;

// 1. Garbage.
allRefused &= await probe('garbage cookie', 'not-a-jwt');

// 2. alg:none — the classic JWT bypass.
const noneToken = [
  Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify({
    iss: 'https://auth.xhostd.com', aud: HOST, sub: 'attacker',
    email: 'zomerg@gmail.com', exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url'),
  '',
].join('.');
allRefused &= await probe('alg:none, claiming the admin email', noneToken);

// 3. Correctly shaped RS256 token signed with our own key, not the platform's.
const { privateKey } = await generateKeyPair('RS256');
const forged = await new SignJWT({ email: 'zomerg@gmail.com', name: 'Attacker' })
  .setProtectedHeader({ alg: 'RS256', kid: 'xhost-2026-06' })
  .setIssuer('https://auth.xhostd.com')
  .setAudience(HOST)
  .setSubject('attacker')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(privateKey);
allRefused &= await probe('RS256 signed with an attacker key, right kid', forged);

// 4. No cookie at all.
const res = await fetch(`${BASE}/api/admin/overview`);
console.log(`  ${res.status === 401 ? 'REFUSED' : '*** ACCEPTED ***'}  no cookie  [${res.status}]`);
allRefused &= res.status === 401;

// 5. The bootstrap token must still work, or recovery is impossible.
const boot = await fetch(`${BASE}/api/admin/overview`, {
  headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
});
console.log(`  ${boot.status === 200 ? 'OK' : 'BROKEN'}     bootstrap token still works [${boot.status}]`);

console.log(allRefused && boot.status === 200 ? '\nall forgeries refused, recovery path intact' : '\nSOMETHING IS WRONG');
process.exit(allRefused && boot.status === 200 ? 0 : 1);

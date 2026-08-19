// Admin API: cookie auth + account management.
// Cookie: aura_admin=<hex hmac>.<exp> — HMAC-SHA256(key=ADMIN_PASSWORD, msg="aura-admin:"+exp).
// Stateless: verification is recompute + compare + expiry check. HttpOnly, Secure, SameSite=Lax.

import { safeEqual, sha256Hex, nowSec, kvGetJson, kvPutJson } from './util';
import type { Env } from './util';
import type { Accounts, Account, Sessions } from './auth';
import { releaseAccountSessions } from './auth';
import { handleRelease } from './releases';

const COOKIE = 'aura_admin';
const ADMIN_TTL = 24 * 3600;
const ALLOWED_ORIGIN = 'https://api.copal.run';

async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function verifyAdmin(req: Request, env: Env): Promise<boolean> {
  const raw = readCookie(req, COOKIE);
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return false;
  const sig = raw.slice(0, dot);
  const exp = Number(raw.slice(dot + 1));
  if (!Number.isFinite(exp) || exp <= nowSec()) return false;
  return safeEqual(sig, await hmacHex(env.ADMIN_PASSWORD, `aura-admin:${exp}`));
}

/** CSRF hardening: state-changing requests from a foreign Origin are rejected. */
function originOk(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  return origin === ALLOWED_ORIGIN;
}

function adminHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...extra,
  };
}

function adminJson(o: unknown, s: number, extra?: Record<string, string>) {
  return new Response(JSON.stringify(o), { status: s, headers: adminHeaders(extra) });
}

// POST /v1/admin/login  {password}
export async function handleAdminLogin(req: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_PASSWORD) return adminJson({ error: 'not_configured' }, 503);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return adminJson({ error: 'bad_request' }, 400);
  }
  const pw = typeof body.password === 'string' ? body.password : '';
  if (!(await safeEqual(pw, env.ADMIN_PASSWORD))) return adminJson({ error: 'forbidden' }, 401);
  const exp = nowSec() + ADMIN_TTL;
  const sig = await hmacHex(env.ADMIN_PASSWORD, `aura-admin:${exp}`);
  return adminJson(
    { ok: true },
    200,
    {
      'set-cookie': `${COOKIE}=${sig}.${exp}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${ADMIN_TTL}`,
    }
  );
}

// POST /v1/admin/logout
export function handleAdminLogout(): Response {
  return adminJson({ ok: true }, 200, {
    'set-cookie': `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
  });
}

function randomId(len: number, chars = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  const out: string[] = [];
  const rand = new Uint8Array(len);
  crypto.getRandomValues(rand);
  for (let i = 0; i < len; i++) out.push(chars[rand[i] % chars.length]);
  return out.join('');
}

// Route /v1/admin/{resource}[/{id}[/{action}]]  — resource: me|login|logout|accounts
export async function handleAdminRoute(
  req: Request,
  env: Env,
  resource: string | undefined,
  id: string | undefined,
  action: string | undefined
): Promise<Response> {
  if (resource === 'login') return handleAdminLogin(req, env);
  if (resource === 'logout') return handleAdminLogout();

  if (!(await verifyAdmin(req, env))) return adminJson({ error: 'forbidden' }, 401);
  if (!originOk(req)) return adminJson({ error: 'forbidden' }, 403);

  if (resource === 'me') return adminJson({ authed: true }, 200);

  if (resource === 'release') {
    if (req.method !== 'POST') return adminJson({ error: 'method_not_allowed' }, 405);
    return handleRelease(req, env);
  }

  if (resource === 'accounts') {
    if (!id) {
      if (req.method === 'GET') return listAccounts(env);
      if (req.method === 'POST') return createAccount(req, env);
      return adminJson({ error: 'method_not_allowed' }, 405);
    }
    if (!action) {
      if (req.method === 'DELETE') return deleteAccount(env, id);
      return adminJson({ error: 'method_not_allowed' }, 405);
    }
    if (req.method !== 'POST') return adminJson({ error: 'method_not_allowed' }, 405);
    if (action === 'extend') return extendAccount(req, env, id);
    if (action === 'disable') return setDisabled(env, id, true);
    if (action === 'enable') return setDisabled(env, id, false);
    if (action === 'budget') return setBudget(req, env, id);
  }
  return adminJson({ error: 'not found' }, 404);
}

async function listAccounts(env: Env): Promise<Response> {
  const [accounts, sessions] = await Promise.all([
    kvGetJson<Accounts>(env.SERVERS, 'accounts', {}),
    kvGetJson<Sessions>(env.SERVERS, 'sessions', {}),
  ]);
  const sessionCounts: Record<string, number> = {};
  for (const s of Object.values(sessions)) {
    sessionCounts[s.account_id] = (sessionCounts[s.account_id] ?? 0) + 1;
  }
  const list = Object.values(accounts).map((a) => ({
    id: a.id,
    name: a.name,
    created_at: a.created_at,
    expires_at: a.expires_at,
    budget_gb: a.budget_gb,
    disabled: !!a.disabled,
    active_sessions: sessionCounts[a.id] ?? 0,
  }));
  list.sort((a, b) => a.created_at - b.created_at);
  return adminJson({ accounts: list }, 200);
}

async function createAccount(req: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return adminJson({ error: 'bad_request' }, 400);
  }
  const name = String(body.name ?? '').trim().slice(0, 64);
  if (!name) return adminJson({ error: 'bad_request' }, 400);
  const budget = typeof body.budget_gb === 'number' && body.budget_gb > 0 ? body.budget_gb : 100;
  const days = typeof body.days === 'number' && body.days > 0 ? Math.floor(body.days) : 30;

  const accounts = await kvGetJson<Accounts>(env.SERVERS, 'accounts', {});
  const id = randomId(8);
  const token = randomId(24, '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  const now = nowSec();
  const acct: Account = {
    id,
    name,
    token_hash: await sha256Hex(token),
    created_at: now,
    expires_at: now + days * 86400,
    budget_gb: budget,
  };
  accounts[id] = acct;
  await kvPutJson(env.SERVERS, 'accounts', accounts);
  return adminJson({ account_id: id, token, expires_at: acct.expires_at }, 200);
}

async function extendAccount(req: Request, env: Env, id: string): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return adminJson({ error: 'bad_request' }, 400);
  }
  const days = typeof body.days === 'number' && body.days > 0 ? Math.floor(body.days) : 30;
  const accounts = await kvGetJson<Accounts>(env.SERVERS, 'accounts', {});
  const acct = accounts[id];
  if (!acct) return adminJson({ error: 'not found' }, 404);
  acct.expires_at = Math.max(nowSec(), acct.expires_at) + days * 86400;
  await kvPutJson(env.SERVERS, 'accounts', accounts);
  return adminJson({ expires_at: acct.expires_at }, 200);
}

async function setDisabled(env: Env, id: string, disabled: boolean): Promise<Response> {
  const accounts = await kvGetJson<Accounts>(env.SERVERS, 'accounts', {});
  const acct = accounts[id];
  if (!acct) return adminJson({ error: 'not found' }, 404);
  acct.disabled = disabled;
  await kvPutJson(env.SERVERS, 'accounts', accounts);
  return adminJson({ ok: true }, 200);
}

async function setBudget(req: Request, env: Env, id: string): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return adminJson({ error: 'bad_request' }, 400);
  }
  const budget = typeof body.budget_gb === 'number' && body.budget_gb > 0 ? body.budget_gb : null;
  if (budget === null) return adminJson({ error: 'bad_request' }, 400);
  const accounts = await kvGetJson<Accounts>(env.SERVERS, 'accounts', {});
  const acct = accounts[id];
  if (!acct) return adminJson({ error: 'not found' }, 404);
  acct.budget_gb = budget;
  await kvPutJson(env.SERVERS, 'accounts', accounts);
  return adminJson({ budget_gb: acct.budget_gb }, 200);
}

async function deleteAccount(env: Env, id: string): Promise<Response> {
  const accounts = await kvGetJson<Accounts>(env.SERVERS, 'accounts', {});
  if (!accounts[id]) return adminJson({ error: 'not found' }, 404);
  delete accounts[id];
  await kvPutJson(env.SERVERS, 'accounts', accounts);
  await releaseAccountSessions(env, id);
  return adminJson({ ok: true }, 200);
}

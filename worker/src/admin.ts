// Admin API: cookie auth + account management.
// Cookie: aura_admin=<hex hmac>.<exp> — HMAC-SHA256(key=ADMIN_PASSWORD, msg="aura-admin:"+exp).
// Stateless: verification is recompute + compare + expiry check. HttpOnly, Secure, SameSite=Lax.

import { safeEqual, nowSec, kvGetJson } from './util';
import type { Sessions } from './auth';
import { releaseAccountSessions } from './auth';
import { handleRelease } from './releases';
import { getDiscordAccount, putDiscordAccount } from './accounts_v2';

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
      if (req.method === 'POST') return adminJson({ error: 'discord_identity_required' }, 410);
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
  const [listed, sessions] = await Promise.all([
    env.SERVERS.list({ prefix: 'account:' }),
    kvGetJson<Sessions>(env.SERVERS, 'sessions', {}),
  ]);
  const sessionCounts: Record<string, number> = {};
  for (const s of Object.values(sessions)) {
    sessionCounts[s.account_id] = (sessionCounts[s.account_id] ?? 0) + 1;
  }
  const accounts = (await Promise.all(listed.keys.map((key) => getDiscordAccount(env, key.name.slice(8))))).filter(
    (account) => account !== null
  );
  const list = accounts.map((a) => ({
    id: a.discord_id,
    name: a.display_name,
    username: a.username,
    created_at: a.created_at,
    expires_at: a.expires_at,
    budget_gb: a.budget_gb,
    disabled: !!a.disabled,
    source: 'discord',
    plan: a.plan,
    active_sessions: sessionCounts[a.discord_id] ?? 0,
  }));
  list.sort((a, b) => a.created_at - b.created_at);
  return adminJson({ accounts: list }, 200);
}

async function extendAccount(req: Request, env: Env, id: string): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return adminJson({ error: 'bad_request' }, 400);
  }
  const days = typeof body.days === 'number' && body.days > 0 ? Math.floor(body.days) : 30;
  const acct = await getDiscordAccount(env, id);
  if (!acct) return adminJson({ error: 'not found' }, 404);
  acct.expires_at = Math.max(nowSec(), acct.expires_at) + days * 86400;
  acct.plan = 'standard';
  acct.updated_at = nowSec();
  await putDiscordAccount(env, acct);
  return adminJson({ expires_at: acct.expires_at }, 200);
}

async function setDisabled(env: Env, id: string, disabled: boolean): Promise<Response> {
  const acct = await getDiscordAccount(env, id);
  if (!acct) return adminJson({ error: 'not found' }, 404);
  acct.disabled = disabled;
  acct.updated_at = nowSec();
  await putDiscordAccount(env, acct);
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
  const acct = await getDiscordAccount(env, id);
  if (!acct) return adminJson({ error: 'not found' }, 404);
  acct.budget_gb = budget;
  acct.updated_at = nowSec();
  await putDiscordAccount(env, acct);
  return adminJson({ budget_gb: acct.budget_gb }, 200);
}

async function deleteAccount(env: Env, id: string): Promise<Response> {
  if (!(await getDiscordAccount(env, id))) return adminJson({ error: 'not found' }, 404);
  await env.SERVERS.delete(`account:${id}`);
  await releaseAccountSessions(env, id);
  return adminJson({ ok: true }, 200);
}

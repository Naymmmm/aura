// Account sessions: cred-pool checkout, heartbeat, release.
// KV keys (all in the SERVERS binding):
//   accounts  — {<account_id>: {id, name, token_hash, created_at, expires_at, budget_gb, disabled}}
//   pool      — {<tag>: [{user, pass, leased_by?, leased_until?}]}   (seeded by infra/06-AddCredPool.ps1)
//   sessions  — {<session_id>: {account_id, created_at, expires_at, last_heartbeat, pairs}}
// KV is eventually consistent: a concurrent login can double-lease a pair (harmless at
// personal scale — both sessions work, the lazy sweep reclaims on expiry).

import { json, safeEqual, sha256Hex, nowSec, kvGetJson, kvPutJson } from './util';
import type { Env } from './util';

export interface Account {
  id: string;
  name: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  budget_gb: number;
  disabled?: boolean;
}
export type Accounts = Record<string, Account>;

export interface PoolEntry {
  user: string;
  pass: string;
  leased_by?: string | null;
  leased_until?: number | null;
}
export type Pool = Record<string, PoolEntry[]>;

export interface Session {
  account_id: string;
  created_at: number;
  expires_at: number;
  last_heartbeat: number;
  pairs: Record<string, { user: string; pass: string }>;
}
export type Sessions = Record<string, Session>;

export const SESSION_TTL = 24 * 3600; // session lives 24h, sliding
export const LEASE_TTL = 48 * 3600; // pool lease outlives the session so a crash leaks nothing past 48h

function releasePairs(pool: Pool, pairs: Record<string, { user: string; pass: string }>): void {
  for (const [tag, pair] of Object.entries(pairs)) {
    const e = (pool[tag] ?? []).find((x) => x.user === pair.user && x.pass === pair.pass);
    if (e) {
      e.leased_by = null;
      e.leased_until = null;
    }
  }
}

/** Sweep expired sessions and stale pool leases. */
function sweep(pool: Pool, sessions: Sessions, now: number): void {
  for (const [id, s] of Object.entries(sessions)) {
    if (now > s.expires_at) delete sessions[id];
  }
  for (const arr of Object.values(pool)) {
    for (const e of arr) {
      if (e.leased_until && now > e.leased_until) {
        e.leased_by = null;
        e.leased_until = null;
      }
    }
  }
}

// POST /v1/session — body {account_id, token}
export async function handleOpenSession(req: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const accountId = typeof body.account_id === 'string' ? body.account_id.trim() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!accountId || !token) return json({ error: 'bad_request' }, 400);

  const accounts = await kvGetJson<Accounts>(env.SERVERS, 'accounts', {});
  const acct = accounts[accountId];
  if (!acct) return json({ error: 'bad_creds' }, 401);
  if (!(await safeEqual(await sha256Hex(token), acct.token_hash))) return json({ error: 'bad_creds' }, 401);
  const now = nowSec();
  if (acct.disabled) return json({ error: 'account_disabled' }, 403);
  if (now > acct.expires_at) return json({ error: 'account_expired' }, 403);

  const [pool, sessions, v1raw] = await Promise.all([
    kvGetJson<Pool>(env.SERVERS, 'pool', {}),
    kvGetJson<Sessions>(env.SERVERS, 'sessions', {}),
    env.SERVERS.get('v1'),
  ]);
  if (!v1raw) return json({ error: 'not_initialized' }, 500);
  const v1 = JSON.parse(v1raw);

  sweep(pool, sessions, now);

  const sid = crypto.randomUUID();
  const pairs: Record<string, { user: string; pass: string }> = {};
  for (const srv of v1.servers) {
    const free = (pool[srv.tag] ?? []).find((e) => !e.leased_by || (e.leased_until ?? 0) <= now);
    if (!free) {
      // roll back marks on earlier tags before reporting exhaustion
      for (const [tag, pair] of Object.entries(pairs)) {
        const e = (pool[tag] ?? []).find((x) => x.user === pair.user && x.pass === pair.pass);
        if (e) {
          e.leased_by = null;
          e.leased_until = null;
        }
      }
      return json({ error: 'pool_exhausted' }, 503);
    }
    free.leased_by = sid;
    free.leased_until = now + LEASE_TTL;
    pairs[srv.tag] = { user: free.user, pass: free.pass };
  }

  sessions[sid] = {
    account_id: accountId,
    created_at: now,
    expires_at: now + SESSION_TTL,
    last_heartbeat: now,
    pairs,
  };
  await kvPutJson(env.SERVERS, 'sessions', sessions);
  await kvPutJson(env.SERVERS, 'pool', pool);

  return json(
    {
      version: v1.version ?? 1,
      session_id: sid,
      expires_at: sessions[sid].expires_at,
      budget_gb: acct.budget_gb,
      prefer_ip: v1.prefer_ip ?? false,
      servers: v1.servers.map((s: any) => ({
        tag: s.tag,
        host: s.host,
        ip: s.ip,
        username: pairs[s.tag].user,
        password: pairs[s.tag].pass,
      })),
    },
    200
  );
}

// POST /v1/session/{id}/heartbeat — slides session + leases
export async function handleHeartbeat(env: Env, sid: string): Promise<Response> {
  const now = nowSec();
  const sessions = await kvGetJson<Sessions>(env.SERVERS, 'sessions', {});
  const s = sessions[sid];
  if (!s || now > s.expires_at) {
    if (s) delete sessions[sid];
    const pool = await kvGetJson<Pool>(env.SERVERS, 'pool', {});
    if (s) releasePairs(pool, s.pairs);
    await kvPutJson(env.SERVERS, 'sessions', sessions);
    await kvPutJson(env.SERVERS, 'pool', pool);
    return json({ error: 'session_gone' }, 410);
  }
  s.expires_at = now + SESSION_TTL;
  s.last_heartbeat = now;
  const pool = await kvGetJson<Pool>(env.SERVERS, 'pool', {});
  for (const [tag, pair] of Object.entries(s.pairs)) {
    const e = (pool[tag] ?? []).find((x) => x.user === pair.user && x.pass === pair.pass);
    if (e) e.leased_until = now + LEASE_TTL;
  }
  await kvPutJson(env.SERVERS, 'sessions', sessions);
  await kvPutJson(env.SERVERS, 'pool', pool);
  return json({ session_id: sid, expires_at: s.expires_at }, 200);
}

// DELETE /v1/session/{id} — idempotent release
export async function handleCloseSession(env: Env, sid: string): Promise<Response> {
  const sessions = await kvGetJson<Sessions>(env.SERVERS, 'sessions', {});
  const s = sessions[sid];
  if (s) {
    delete sessions[sid];
    const pool = await kvGetJson<Pool>(env.SERVERS, 'pool', {});
    releasePairs(pool, s.pairs);
    await kvPutJson(env.SERVERS, 'pool', pool);
    await kvPutJson(env.SERVERS, 'sessions', sessions);
  }
  return json({ ok: true }, 200);
}

/** Delete every session of an account and free its leases (admin account delete). */
export async function releaseAccountSessions(env: Env, accountId: string): Promise<void> {
  const sessions = await kvGetJson<Sessions>(env.SERVERS, 'sessions', {});
  let changed = false;
  for (const [id, s] of Object.entries(sessions)) {
    if (s.account_id === accountId) {
      delete sessions[id];
      changed = true;
    }
  }
  if (!changed) return;
  const pool = await kvGetJson<Pool>(env.SERVERS, 'pool', {});
  for (const arr of Object.values(pool)) {
    for (const e of arr) {
      if (e.leased_by && !sessions[e.leased_by]) {
        e.leased_by = null;
        e.leased_until = null;
      }
    }
  }
  await kvPutJson(env.SERVERS, 'sessions', sessions);
  await kvPutJson(env.SERVERS, 'pool', pool);
}

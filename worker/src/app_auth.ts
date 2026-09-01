import { getDiscordAccount, upsertDiscordIdentity } from './accounts_v2';
import type { DiscordAccount } from './accounts_v2';
import { json, nowSec, safeEqual, sha256Hex } from './util';

const DISCORD_API = 'https://discord.com/api/v10';
const LOGIN_TTL = 10 * 60;
const APP_TOKEN_TTL = 14 * 86400;
const APP_CALLBACK = 'https://api.copal.run/v1/auth/discord/callback';

interface PendingLogin {
  secret_hash: string;
  state: string;
  expires_at: number;
  status: 'pending' | 'approved';
  discord_id?: string;
}

interface AppSession {
  discord_id: string;
  expires_at: number;
}

function randomHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pendingLogin(value: unknown): PendingLogin | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('secret_hash' in value) ||
    typeof value.secret_hash !== 'string' ||
    !('state' in value) ||
    typeof value.state !== 'string' ||
    !('expires_at' in value) ||
    typeof value.expires_at !== 'number' ||
    !('status' in value) ||
    (value.status !== 'pending' && value.status !== 'approved')
  ) {
    return null;
  }
  if ('discord_id' in value && value.discord_id !== undefined && typeof value.discord_id !== 'string') {
    return null;
  }
  return value as PendingLogin;
}

export async function startAppDiscordLogin(env: Env): Promise<Response> {
  const loginId = crypto.randomUUID();
  const loginSecret = randomHex(32);
  const state = randomHex(32);
  const expiresAt = nowSec() + LOGIN_TTL;
  const login: PendingLogin = {
    secret_hash: await sha256Hex(loginSecret),
    state,
    expires_at: expiresAt,
    status: 'pending',
  };
  await Promise.all([
    env.SERVERS.put(`app-login:${loginId}`, JSON.stringify(login), { expirationTtl: LOGIN_TTL }),
    env.SERVERS.put(`app-oauth-state:${state}`, loginId, { expirationTtl: LOGIN_TTL }),
  ]);

  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authorize.searchParams.set('scope', 'identify guilds.members.read');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('redirect_uri', APP_CALLBACK);
  return json(
    {
      login_id: loginId,
      login_secret: loginSecret,
      authorize_url: authorize.toString(),
      expires_at: expiresAt,
    },
    200
  );
}

async function discordJson(url: string, accessToken: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Discord API ${response.status}`);
  return response.json();
}

export async function finishAppDiscordLogin(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const loginId = state ? await env.SERVERS.get(`app-oauth-state:${state}`) : null;
  if (!code || !state || !loginId) return json({ error: 'invalid_oauth_state' }, 400);
  const login = pendingLogin(await env.SERVERS.get(`app-login:${loginId}`, 'json'));
  if (!login || login.state !== state || login.expires_at <= nowSec()) {
    return json({ error: 'invalid_oauth_state' }, 400);
  }

  try {
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: APP_CALLBACK,
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
      }),
    });
    if (!tokenResponse.ok) return json({ error: 'discord_oauth_failed' }, 502);
    const tokenBody: unknown = await tokenResponse.json();
    if (
      !tokenBody ||
      typeof tokenBody !== 'object' ||
      !('access_token' in tokenBody) ||
      typeof tokenBody.access_token !== 'string'
    ) {
      return json({ error: 'discord_oauth_failed' }, 502);
    }
    const [user, member] = await Promise.all([
      discordJson(`${DISCORD_API}/users/@me`, tokenBody.access_token),
      discordJson(
        `${DISCORD_API}/users/@me/guilds/${encodeURIComponent(env.DISCORD_GUILD_ID)}/member`,
        tokenBody.access_token
      ),
    ]);
    if (!member || typeof member !== 'object') return json({ error: 'discord_membership_required' }, 403);
    if (
      !user ||
      typeof user !== 'object' ||
      !('id' in user) ||
      typeof user.id !== 'string' ||
      !/^\d+$/.test(user.id) ||
      !('username' in user) ||
      typeof user.username !== 'string'
    ) {
      return json({ error: 'discord_oauth_failed' }, 502);
    }
    const displayName =
      'global_name' in user && typeof user.global_name === 'string' ? user.global_name : user.username;
    await upsertDiscordIdentity(env, {
      discordId: user.id,
      username: user.username,
      displayName,
    });
    login.status = 'approved';
    login.discord_id = user.id;
    await env.SERVERS.put(`app-login:${loginId}`, JSON.stringify(login), {
      expirationTtl: Math.max(60, login.expires_at - nowSec()),
    });
    return new Response(
      '<!doctype html><html><head><meta charset="utf-8"><title>Aura authorized</title></head><body><h1>Aura authorized</h1><p>Return to Aura to finish signing in. You can close this tab.</p></body></html>',
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        },
      }
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'app Discord OAuth failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return json({ error: 'discord_unavailable' }, 502);
  }
}

export async function pollAppDiscordLogin(req: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !('login_id' in body) ||
    typeof body.login_id !== 'string' ||
    !('login_secret' in body) ||
    typeof body.login_secret !== 'string'
  ) {
    return json({ error: 'bad_request' }, 400);
  }
  const key = `app-login:${body.login_id}`;
  const login = pendingLogin(await env.SERVERS.get(key, 'json'));
  if (!login || login.expires_at <= nowSec()) return json({ error: 'login_expired' }, 410);
  if (!(await safeEqual(await sha256Hex(body.login_secret), login.secret_hash))) {
    return json({ error: 'forbidden' }, 403);
  }
  if (login.status === 'pending' || !login.discord_id) return json({ status: 'pending' }, 202);
  const account = await getDiscordAccount(env, login.discord_id);
  if (!account) return json({ error: 'account_missing' }, 500);
  const token = `aura_${randomHex(32)}`;
  const tokenExpiresAt = nowSec() + APP_TOKEN_TTL;
  const session: AppSession = { discord_id: login.discord_id, expires_at: tokenExpiresAt };
  await Promise.all([
    env.SERVERS.put(`app-session:${await sha256Hex(token)}`, JSON.stringify(session), {
      expirationTtl: APP_TOKEN_TTL,
    }),
    env.SERVERS.delete(key),
    env.SERVERS.delete(`app-oauth-state:${login.state}`),
  ]);
  return json({ token, token_expires_at: tokenExpiresAt, account: publicAccount(account) }, 200);
}

export async function authenticateAppToken(
  req: Request,
  env: Env
): Promise<{ session: AppSession; account: DiscordAccount } | null> {
  const authorization = req.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!/^aura_[a-f0-9]{64}$/.test(token)) return null;
  const value = await env.SERVERS.get(`app-session:${await sha256Hex(token)}`, 'json');
  if (
    !value ||
    typeof value !== 'object' ||
    !('discord_id' in value) ||
    typeof value.discord_id !== 'string' ||
    !('expires_at' in value) ||
    typeof value.expires_at !== 'number' ||
    value.expires_at <= nowSec()
  ) {
    return null;
  }
  const session: AppSession = { discord_id: value.discord_id, expires_at: value.expires_at };
  const account = await getDiscordAccount(env, session.discord_id);
  return account ? { session, account } : null;
}

export async function revokeAppToken(req: Request, env: Env): Promise<Response> {
  const authorization = req.headers.get('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!/^aura_[a-f0-9]{64}$/.test(token)) return json({ error: 'invalid_auth_token' }, 401);
  await env.SERVERS.delete(`app-session:${await sha256Hex(token)}`);
  return json({ ok: true }, 200);
}

export function publicAccount(account: DiscordAccount) {
  return {
    discord_id: account.discord_id,
    username: account.username,
    display_name: account.display_name,
    expires_at: account.expires_at,
    budget_gb: account.budget_gb,
    disabled: account.disabled,
    plan: account.plan,
    trial_claimed_at: account.trial_claimed_at ?? null,
  };
}

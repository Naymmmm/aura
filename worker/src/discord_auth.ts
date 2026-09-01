import { json, nowSec, safeEqual } from './util';

const OAUTH_STATE_COOKIE = 'aura_oauth_state';
const DOWNLOAD_COOKIE = 'aura_download';
const OAUTH_STATE_TTL = 10 * 60;
const DOWNLOAD_SESSION_TTL = 15 * 60;
const DISCORD_API = 'https://discord.com/api/v10';

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function safeReturnTo(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/downloads';
  return raw;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function loginRedirect(returnTo: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `/auth/discord/login?return_to=${encodeURIComponent(returnTo)}` },
  });
}

export async function hasDownloadSession(req: Request, env: Env): Promise<boolean> {
  return (await downloadSessionDiscordId(req, env)) !== null;
}

export async function downloadSessionDiscordId(req: Request, env: Env): Promise<string | null> {
  const raw = readCookie(req, DOWNLOAD_COOKIE);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [userId, rawExp, signature] = parts;
  const exp = Number(rawExp);
  if (!/^\d+$/.test(userId) || !Number.isFinite(exp) || exp <= nowSec()) return null;
  return await safeEqual(signature, await hmacHex(env.DOWNLOAD_SESSION_SECRET, `${userId}:${exp}`))
    ? userId
    : null;
}

export function handleDiscordLogin(req: Request, env: Env): Response {
  const url = new URL(req.url);
  const returnTo = safeReturnTo(url.searchParams.get('return_to'));
  const state = randomToken();
  const stateValue = `${state}.${nowSec() + OAUTH_STATE_TTL}.${encodeURIComponent(returnTo)}`;
  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', env.DISCORD_CLIENT_ID);
  authorize.searchParams.set('scope', 'identify guilds.members.read');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('redirect_uri', 'https://api.copal.run/auth/discord/callback');
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      'cache-control': 'no-store',
      'set-cookie': `${OAUTH_STATE_COOKIE}=${stateValue}; HttpOnly; Secure; SameSite=Lax; Path=/auth/discord; Max-Age=${OAUTH_STATE_TTL}`,
    },
  });
}

function clearOauthState(): string {
  return `${OAUTH_STATE_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/auth/discord; Max-Age=0`;
}

function stateParts(raw: string | null): { state: string; exp: number; returnTo: string } | null {
  if (!raw) return null;
  const first = raw.indexOf('.');
  const second = raw.indexOf('.', first + 1);
  if (first <= 0 || second <= first) return null;
  const state = raw.slice(0, first);
  const exp = Number(raw.slice(first + 1, second));
  if (!Number.isFinite(exp)) return null;
  try {
    return { state, exp, returnTo: safeReturnTo(decodeURIComponent(raw.slice(second + 1))) };
  } catch {
    return null;
  }
}

async function discordJson(url: string, accessToken: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`Discord API ${response.status}`);
  return response.json();
}

export async function handleDiscordCallback(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get('code') ?? '';
  const returnedState = url.searchParams.get('state') ?? '';
  const saved = stateParts(readCookie(req, OAUTH_STATE_COOKIE));
  if (
    !code ||
    !returnedState ||
    !saved ||
    saved.exp <= nowSec() ||
    !(await safeEqual(returnedState, saved.state))
  ) {
    return json({ error: 'invalid_oauth_state' }, 400);
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://api.copal.run/auth/discord/callback',
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
    });
    const tokenResponse = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
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

    const [userBody, memberBody] = await Promise.all([
      discordJson(`${DISCORD_API}/users/@me`, tokenBody.access_token),
      discordJson(
        `${DISCORD_API}/users/@me/guilds/${encodeURIComponent(env.DISCORD_GUILD_ID)}/member`,
        tokenBody.access_token
      ),
    ]);
    if (
      !userBody ||
      typeof userBody !== 'object' ||
      !('id' in userBody) ||
      typeof userBody.id !== 'string' ||
      !/^\d+$/.test(userBody.id)
    ) {
      return json({ error: 'discord_oauth_failed' }, 502);
    }
    const roles =
      memberBody && typeof memberBody === 'object' && 'roles' in memberBody && Array.isArray(memberBody.roles)
        ? memberBody.roles.filter((role): role is string => typeof role === 'string')
        : [];
    if (!roles.includes(env.DISCORD_REQUIRED_ROLE_ID)) {
      return new Response(JSON.stringify({ error: 'required_discord_role' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'set-cookie': clearOauthState(),
        },
      });
    }

    const exp = nowSec() + DOWNLOAD_SESSION_TTL;
    const signature = await hmacHex(env.DOWNLOAD_SESSION_SECRET, `${userBody.id}:${exp}`);
    const headers = new Headers({ location: saved.returnTo, 'cache-control': 'no-store' });
    headers.append('set-cookie', clearOauthState());
    headers.append(
      'set-cookie',
      `${DOWNLOAD_COOKIE}=${userBody.id}.${exp}.${signature}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DOWNLOAD_SESSION_TTL}`
    );
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Discord OAuth callback failed',
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return json({ error: 'discord_unavailable' }, 502);
  }
}

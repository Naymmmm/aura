// copal-api — central config API for the Aura VPN.
// GET  /healthz                  → public liveness
// GET  /v1/config                → server list + credentials (X-Copal-Secret)
// POST /v1/signup                → public self-service account (no credit)
// POST /v1/session               → account login, cred-pool checkout
// POST /v1/session/{id}/heartbeat → keep session alive
// DELETE /v1/session/{id}        → release session
// GET  /v1/release/meta?key=     → {version, sha256, size} for the auto-updater
// GET  /admin                    → admin panel HTML
// /v1/admin/...                  → admin API (login/logout/me/accounts/release)
// GET  /archive                → Discord-gated version archive (Stable / Dev)
// GET  /dl/{key}                 → Discord-gated release download

import { json, HDRS, safeEqual } from './util';
import { authenticateLegacyCredentials, handleOpenSession, handleHeartbeat, handleCloseSession } from './auth';
import { handleAdminRoute } from './admin';
import { serveAdminPage } from './admin_page';
import { serveDownload, serveArchivePage, serveReleaseMeta } from './releases';
import { handleCiRelease, handleCiReleaseAnnouncement } from './releases';
import {
  handleDiscordCallback,
  handleDiscordLogin,
  downloadSessionDiscordId,
  loginRedirect,
} from './discord_auth';
import { authenticateAppToken, finishAppDiscordLogin, handleAppDiscordHandoff, pollAppDiscordLogin, revokeAppToken, startAppDiscordLogin } from './app_auth';
import { handleDiscordInteraction, reconcileExpiredAccountRoles } from './discord_bot';
import { getDiscordAccount } from './accounts_v2';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HDRS });
    if (url.pathname === '/healthz') return new Response('ok');
    if (url.pathname === '/v1/config') return serveConfig(req, env);

    if (url.pathname === '/v1/auth/discord/start') {
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return startAppDiscordLogin(env);
    }
    if (url.pathname === '/v1/auth/discord/callback') return finishAppDiscordLogin(req, env);
    if (url.pathname === '/v1/auth/discord/poll') {
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return pollAppDiscordLogin(req, env);
    }
    if (url.pathname === '/v1/auth/session') {
      if (req.method !== 'DELETE') return json({ error: 'method_not_allowed' }, 405);
      return revokeAppToken(req, env);
    }
    const deviceMatch = url.pathname.match(/^\/auth\/device\/([a-f0-9]{16})(\/continue)?$/);
    if (deviceMatch) {
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return handleAppDiscordHandoff(req, env, deviceMatch[1], !!deviceMatch[2]);
    }
    if (url.pathname === '/v1/discord/interactions') {
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return handleDiscordInteraction(req, env);
    }

    if (url.pathname === '/v1/signup') {
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return json({ error: 'discord_auth_required' }, 410);
    }

    if (url.pathname === '/v1/release/meta') {
      if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
      return serveReleaseMeta(req, env);
    }

    if (url.pathname === '/v1/releases/publish') {
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return handleCiRelease(req, env);
    }
    if (url.pathname === '/v1/releases/announce') {
      if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return handleCiReleaseAnnouncement(req, env);
    }

    if (url.pathname === '/auth/discord/login') return handleDiscordLogin(req, env);
    if (url.pathname === '/auth/discord/callback') return handleDiscordCallback(req, env);

    if (url.pathname === '/downloads') {
      // Legacy name
      return Response.redirect(`${url.origin}/archive`, 308);
    }
    if (url.pathname === '/archive') {
      const access = await downloadAccess(req, env);
      if (!access.authenticated) return loginRedirect('/archive');
      return serveArchivePage(env, access.canDownloadSource);
    }

    const sessMatch = url.pathname.match(/^\/v1\/session(?:\/([^/]+)(?:\/([^/]+))?)?$/);
    if (sessMatch) return serveSession(req, env, sessMatch[1], sessMatch[2]);

    if (url.pathname === '/admin') return serveAdminPage();

    if (url.pathname.startsWith('/dl/')) {
      const access = await downloadAccess(req, env);
      if (!access.authenticated) return loginRedirect(url.pathname);
      const key = url.pathname.slice(4);
      if (isSourceKey(key) && !access.canDownloadSource) return json({ error: 'standard_required' }, 403);
      return serveDownload(req, env, key);
    }

    // /v1/admin/{resource}[/{id}[/{action}]] — resource: login|logout|me|accounts|release
    const adminMatch = url.pathname.match(/^\/v1\/admin\/([a-z]+)(?:\/([^/]+))?(?:\/([a-z]+))?$/);
    if (adminMatch) return handleAdminRoute(req, env, adminMatch[1], adminMatch[2], adminMatch[3]);

    return json({ error: 'not found' }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcileExpiredAccountRoles(env));
  },
} satisfies ExportedHandler<Env>;

async function downloadAccess(req: Request, env: Env): Promise<{ authenticated: boolean; canDownloadSource: boolean }> {
  const appAccount = await authenticateAppToken(req, env);
  if (appAccount) return { authenticated: true, canDownloadSource: isStandard(appAccount.account.plan) };
  const legacyId = req.headers.get('x-aura-account-id') ?? '';
  const authorization = req.headers.get('authorization') ?? '';
  const legacyToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const legacy = legacyId ? await authenticateLegacyCredentials(env, legacyId, legacyToken) : null;
  if (
    legacy &&
    !legacy.disabled &&
    legacy.expires_at > Math.floor(Date.now() / 1000)
  ) {
    return { authenticated: true, canDownloadSource: true };
  }
  const discordId = await downloadSessionDiscordId(req, env);
  if (!discordId) return { authenticated: false, canDownloadSource: false };
  const account = await getDiscordAccount(env, discordId);
  return { authenticated: true, canDownloadSource: !!account && isStandard(account.plan) };
}

function isStandard(plan: string): boolean { return plan === 'standard' || plan === 'paid'; }

function isSourceKey(key: string): boolean { return key === 'source' || /\/source\.zip$/.test(key); }

// Legacy shared-secret config path — byte-identical behavior, keep forever
// (old app builds depend on it; static creds remain the emergency fallback).
async function serveConfig(req: Request, env: Env): Promise<Response> {
  if (!env.API_SECRET) return json({ error: 'not configured' }, 500);
  const supplied = req.headers.get('x-copal-secret') ?? '';
  if (!supplied) return json({ error: 'forbidden' }, 403);
  if (!(await safeEqual(supplied, env.API_SECRET))) return json({ error: 'forbidden' }, 403);

  const raw = await env.SERVERS.get('v1');
  if (!raw) return json({ error: 'not initialized' }, 500);
  return new Response(raw, { headers: HDRS });
}

async function serveSession(
  req: Request,
  env: Env,
  id: string | undefined,
  action: string | undefined
): Promise<Response> {
  if (!id) {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return handleOpenSession(req, env);
  }
  if (action === 'heartbeat') {
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    return handleHeartbeat(env, id);
  }
  if (req.method === 'DELETE') return handleCloseSession(env, id);
  return json({ error: 'method_not_allowed' }, 405);
}

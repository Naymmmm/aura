import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://api.copal.run${path}`, init);
}

async function startLogin() {
  const response = await worker.fetch(request('/v1/auth/discord/start', { method: 'POST' }), env);
  expect(response.status).toBe(200);
  return response.json<{
    login_id: string;
    login_secret: string;
    authorize_url: string;
    expires_at: number;
    handoff_url: string;
  }>();
}

describe('Discord app authentication', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retires public generated-ID signup in favor of Discord identity', async () => {
    const response = await worker.fetch(request('/v1/signup', { method: 'POST' }), env);

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'discord_auth_required' });
  });

  it('starts a one-time browser login with a separate polling secret', async () => {
    const login = await startLogin();
    const authorize = new URL(login.authorize_url);

    expect(authorize.origin).toBe('https://discord.com');
    expect(authorize.searchParams.get('scope')).toBe('identify guilds.members.read');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://api.copal.run/v1/auth/discord/callback'
    );
    expect(login.login_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(login.login_secret).toMatch(/^[a-f0-9]{64}$/);
    expect(login.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(login.handoff_url).toMatch(/^https:\/\/api\.copal\.run\/auth\/device\/[a-f0-9]{16}$/);
  });

  it('offers a temporary handoff page for approval on an unfiltered device', async () => {
    const login = await startLogin();
    const handoff = new URL(login.handoff_url);
    const page = await worker.fetch(request(handoff.pathname), env);
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain('Use an unfiltered device');
    expect(html).toContain(login.handoff_url);

    const redirect = await worker.fetch(request(`${handoff.pathname}/continue`), env);
    expect(redirect.status).toBe(302);
    expect(new URL(redirect.headers.get('location')!).origin).toBe('https://discord.com');
  });

  it('returns pending before Discord approves the browser login', async () => {
    const login = await startLogin();
    const response = await worker.fetch(
      request('/v1/auth/discord/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login_id: login.login_id, login_secret: login.login_secret }),
      }),
      env
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: 'pending' });
  });

  it('exchanges Discord approval for a one-time 14-day app token', async () => {
    const login = await startLogin();
    const state = new URL(login.authorize_url).searchParams.get('state')!;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'discord-token' });
        if (url.endsWith('/users/@me')) {
          return Response.json({ id: '900000000000000001', username: 'trial_user', global_name: 'Trial User' });
        }
        return Response.json({ roles: [] });
      })
    );

    const callback = await worker.fetch(
      request(`/v1/auth/discord/callback?code=oauth-code&state=${state}`),
      env
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain('Return to Aura');

    const before = Math.floor(Date.now() / 1000);
    const poll = await worker.fetch(
      request('/v1/auth/discord/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login_id: login.login_id, login_secret: login.login_secret }),
      }),
      env
    );
    const result = await poll.json<{
      token: string;
      token_expires_at: number;
      account: { discord_id: string; username: string; plan: string };
    }>();

    expect(poll.status).toBe(200);
    expect(result.token).toMatch(/^aura_[a-f0-9]{64}$/);
    expect(result.token_expires_at).toBeGreaterThanOrEqual(before + 14 * 86400 - 1);
    expect(result.token_expires_at).toBeLessThanOrEqual(before + 14 * 86400 + 1);
    expect(result.account).toMatchObject({
      discord_id: '900000000000000001',
      username: 'trial_user',
      plan: 'none',
    });

    const replay = await worker.fetch(
      request('/v1/auth/discord/poll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login_id: login.login_id, login_secret: login.login_secret }),
      }),
      env
    );
    expect(replay.status).toBe(410);
  });

  it('opens VPN sessions with the saved bearer token and returns trial status', async () => {
    await env.SERVERS.put(
      'account:900000000000000002',
      JSON.stringify({
        discord_id: '900000000000000002',
        username: 'freebie',
        display_name: 'Free User',
        created_at: 1,
        expires_at: Math.floor(Date.now() / 1000) + 7 * 86400,
        budget_gb: 1,
        disabled: false,
        plan: 'free_trial',
        trial_claimed_at: 1,
      })
    );
    const token = 'aura_' + 'a'.repeat(64);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const appTokenExpiresAt = Math.floor(Date.now() / 1000) + 3600;
    await env.SERVERS.put(
      `app-session:${hash}`,
      JSON.stringify({ discord_id: '900000000000000002', expires_at: appTokenExpiresAt })
    );
    await env.SERVERS.put(
      'v1',
      JSON.stringify({ version: 1, servers: [{ tag: 'romeo', host: 'romeo.example', ip: '1.2.3.4' }] })
    );
    await env.SERVERS.put('pool', JSON.stringify({ romeo: [{ user: 'leased-user', pass: 'leased-pass' }] }));

    const response = await worker.fetch(
      request('/v1/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
      env
    );
    const body = await response.json<{
      account: { discord_id: string; plan: string; expires_at: number };
      budget_gb: number;
      expires_at: number;
    }>();

    expect(response.status).toBe(200);
    expect(body.budget_gb).toBe(1);
    expect(body.expires_at).toBeLessThanOrEqual(appTokenExpiresAt);
    expect(body.account).toMatchObject({
      discord_id: '900000000000000002',
      plan: 'free_trial',
    });
  });

  it('keeps legacy account credentials as a compatibility-only session path', async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('legacy-token'));
    const tokenHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    await env.SERVERS.put('accounts', JSON.stringify({
      legacy01: {
        id: 'legacy01',
        name: 'Legacy User',
        token_hash: tokenHash,
        created_at: 1,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        budget_gb: 50,
        source: 'admin',
      },
    }));
    await env.SERVERS.put(
      'v1',
      JSON.stringify({ version: 1, servers: [{ tag: 'romeo', host: 'romeo.example', ip: '1.2.3.4' }] })
    );
    await env.SERVERS.put('pool', JSON.stringify({ romeo: [{ user: 'leased-user', pass: 'leased-pass' }] }));

    const response = await worker.fetch(
      request('/v1/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: 'legacy01', token: 'legacy-token' }),
      }),
      env
    );
    const body = await response.json<{ account: { discord_id: string; display_name: string; plan: string } }>();

    expect(response.status).toBe(200);
    expect(body.account).toMatchObject({
      discord_id: 'legacy01',
      display_name: 'Legacy User',
      plan: 'standard',
    });
  });

  it('revokes the saved app token on logout', async () => {
    const token = `aura_${'c'.repeat(64)}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await env.SERVERS.put(
      `app-session:${hash}`,
      JSON.stringify({ discord_id: '900000000000000003', expires_at: Math.floor(Date.now() / 1000) + 86400 })
    );

    const response = await worker.fetch(
      request('/v1/auth/session', { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }),
      env
    );

    expect(response.status).toBe(200);
    expect(await env.SERVERS.get(`app-session:${hash}`)).toBeNull();
  });
});

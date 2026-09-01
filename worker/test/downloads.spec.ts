import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://api.copal.run${path}`, init);
}

async function publishArtifact(version: string, artifact: 'windows' | 'macos' | 'source', body: string) {
  const form = new FormData();
  form.set('version', version);
  form.set('artifact', artifact);
  form.set('file', new File([body], `${artifact}.zip`, { type: 'application/zip' }));
  return worker.fetch(
    request('/v1/releases/publish', {
      method: 'POST',
      headers: { authorization: 'Bearer test-release-upload-token' },
      body: form,
    }),
    env
  );
}

async function downloadSessionCookie(plan?: 'free_trial' | 'standard'): Promise<string> {
  const login = await worker.fetch(request('/auth/discord/login'), env);
  const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
  const stateCookie = login.headers.get('set-cookie')!.split(';', 1)[0];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'token' });
      if (url.endsWith('/users/@me')) return Response.json({ id: '123456789', username: 'auraking' });
      return Response.json({ roles: ['1544233739322789948'] });
    })
  );
  const callback = await worker.fetch(
    request(`/auth/discord/callback?code=oauth-code&state=${state}`, {
      headers: { cookie: stateCookie },
    }),
    env
  );
  vi.unstubAllGlobals();
  if (plan) {
    await env.SERVERS.put(
      'account:123456789',
      JSON.stringify({
        discord_id: '123456789', username: 'auraking', display_name: 'Aura King', created_at: 1,
        expires_at: Math.floor(Date.now() / 1000) + 86400, budget_gb: 1, disabled: false, plan,
        ...(plan === 'free_trial' ? { trial_claimed_at: 1 } : {}),
      })
    );
  }
  const match = callback.headers.get('set-cookie')?.match(/aura_download=([^;,\s]+)/);
  if (!match) throw new Error('download session cookie missing');
  return `aura_download=${match[1]}`;
}

describe('Discord-gated downloads', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('redirects the download portal to Discord authentication', async () => {
    const response = await worker.fetch(request('/downloads'), env);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/auth/discord/login?return_to=%2Fdownloads');
  });

  it('redirects direct artifact downloads while preserving the requested path', async () => {
    const response = await worker.fetch(request('/dl/latest'), env);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/auth/discord/login?return_to=%2Fdl%2Flatest');
  });

  it('starts Discord OAuth with state and the member-read scope', async () => {
    const response = await worker.fetch(request('/auth/discord/login?return_to=%2Fdownloads'), env);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://discord.com');
    expect(location.pathname).toBe('/oauth2/authorize');
    expect(location.searchParams.get('client_id')).toBe('discord-client-id');
    expect(location.searchParams.get('scope')).toBe('identify guilds.members.read');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(response.headers.get('set-cookie')).toContain('aura_oauth_state=');
  });

  it('rejects CI release publishing without its bearer token', async () => {
    const response = await worker.fetch(
      request('/v1/releases/publish', { method: 'POST', body: new FormData() }),
      env
    );

    expect(response.status).toBe(401);
  });

  it('publishes a versioned artifact and points the latest alias at it', async () => {
    const form = new FormData();
    form.set('version', 'v0.3.0');
    form.set('artifact', 'windows');
    form.set('file', new File(['windows-build'], 'aura-windows-amd64.zip', { type: 'application/zip' }));

    const response = await worker.fetch(
      request('/v1/releases/publish', {
        method: 'POST',
        headers: { authorization: 'Bearer test-release-upload-token' },
        body: form,
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      version: 'v0.3.0',
      artifact: 'windows',
      key: 'archive/v0.3.0/windows.zip',
    });
    expect(await (await env.RELEASES.get('archive/v0.3.0/windows.zip'))!.text()).toBe('windows-build');
    expect(await (await env.RELEASES.get('meta:latest'))!.json()).toMatchObject({
      version: 'v0.3.0',
      target: 'archive/v0.3.0/windows.zip',
    });
  });

  it('publishes source into the same version archive and updates its manifest', async () => {
    const form = new FormData();
    form.set('version', 'v0.3.0');
    form.set('artifact', 'source');
    form.set('file', new File(['source-code'], 'aura-source.zip', { type: 'application/zip' }));

    const response = await worker.fetch(
      request('/v1/releases/publish', {
        method: 'POST',
        headers: { authorization: 'Bearer test-release-upload-token' },
        body: form,
      }),
      env
    );

    expect(response.status).toBe(200);
    const manifest = await (await env.RELEASES.get('archive/v0.3.0/manifest.json'))!.json<{
      artifacts: Record<string, { key: string }>;
    }>();
    expect(manifest.artifacts.source.key).toBe('archive/v0.3.0/source.zip');
    expect(await (await env.RELEASES.get('meta:source'))!.json()).toMatchObject({
      version: 'v0.3.0',
      target: 'archive/v0.3.0/source.zip',
    });
  });

  it('rejects invalid archive artifact names', async () => {
    const form = new FormData();
    form.set('version', 'v0.3.0');
    form.set('artifact', '../secret');
    form.set('file', new File(['bad'], 'bad.zip'));

    const response = await worker.fetch(
      request('/v1/releases/publish', {
        method: 'POST',
        headers: { authorization: 'Bearer test-release-upload-token' },
        body: form,
      }),
      env
    );

    expect(response.status).toBe(400);
  });

  it('uses a CI-supplied sha256 without hashing the uploaded binary in the worker', async () => {
    const suppliedSha = 'a'.repeat(64);
    const form = new FormData();
    form.set('version', 'v0.3.0');
    form.set('artifact', 'macos');
    form.set('sha256', suppliedSha);
    form.set('file', new File(['large-build'], 'aura-macos-arm64.zip', { type: 'application/zip' }));

    const response = await worker.fetch(
      request('/v1/releases/publish', {
        method: 'POST',
        headers: { authorization: 'Bearer test-release-upload-token' },
        body: form,
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sha256: suppliedSha });
    expect(await (await env.RELEASES.get('meta:latest-macos'))!.json()).toMatchObject({
      sha256: suppliedSha,
    });
  });

  it('archives historical releases without promoting them over the current version', async () => {
    await publishArtifact('v0.3.1', 'windows', 'current');

    const historical = new FormData();
    historical.set('version', 'v0.2.6');
    historical.set('artifact', 'windows');
    historical.set('promote', 'false');
    historical.set('file', new File(['old'], 'old.zip', { type: 'application/zip' }));
    const response = await worker.fetch(
      request('/v1/releases/publish', {
        method: 'POST',
        headers: { authorization: 'Bearer test-release-upload-token' },
        body: historical,
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(await (await env.RELEASES.get('meta:latest'))!.json()).toMatchObject({ version: 'v0.3.1' });
    const index = await (await env.RELEASES.get('archive/index.json'))!.json<{
      versions: Array<{ version: string }>;
    }>();
    const versions = index.versions.map((entry) => entry.version);
    expect(versions.indexOf('v0.3.1')).toBeLessThan(versions.indexOf('v0.2.6'));
  });

  it('announces a completed release changelog through the Aura bot only once', async () => {
    const version = 'v0.7.0';
    await publishArtifact(version, 'windows', 'windows-v7');
    await publishArtifact(version, 'macos', 'macos-v7');
    await publishArtifact(version, 'source', 'source-v7');
    const changelog = '# v0.70\n```diff\n+ Discord access:\n- ships automatically\n```\n\n[Windows Download](https://api.copal.run/dl/latest)\n[macOS Download](https://api.copal.run/dl/latest-macos)\n[Source Download](https://api.copal.run/dl/source)\n\n<@&1544233739322789948>';
    const outbound = vi.fn(async () => Response.json({ id: 'discord-message-id' }));
    vi.stubGlobal('fetch', outbound);

    const announce = () => worker.fetch(
      request('/v1/releases/announce', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-release-upload-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ version, changelog }),
      }),
      env
    );
    const first = await announce();
    const second = await announce();

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ announced: true, message_id: 'discord-message-id' });
    expect(await second.json()).toMatchObject({ announced: false, already_announced: true });
    expect(outbound).toHaveBeenCalledTimes(1);
    expect(outbound).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/discord-release-channel-id/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: changelog, allowed_mentions: { roles: ['1544233739322789948'] } }),
      })
    );
  });

  it('refuses to announce before Windows, macOS, and source are archived', async () => {
    const response = await worker.fetch(
      request('/v1/releases/announce', {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-release-upload-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          version: 'v0.8.0',
          changelog: '# v0.80\n```diff\n+ Release:\n- pending artifacts\n```\n\n[Windows Download](https://api.copal.run/dl/latest)\n[macOS Download](https://api.copal.run/dl/latest-macos)\n[Source Download](https://api.copal.run/dl/source)\n\n<@&1544233739322789948>',
        }),
      }),
      env
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'release_incomplete' });
  });

  it('renders the version archive for an authorized Discord member', async () => {
    await publishArtifact('v0.4.0', 'windows', 'windows-v4');
    await publishArtifact('v0.4.0', 'source', 'source-v4');
    const cookie = await downloadSessionCookie('standard');

    const response = await worker.fetch(request('/downloads', { headers: { cookie } }), env);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<h1>Aura Downloads</h1>');
    expect(html).toContain('class="latest-release"');
    expect(html).toContain('class="older-releases"');
    expect(html).toContain('v0.4.0');
    expect(html).toContain('/dl/archive/v0.4.0/windows.zip');
    expect(html).toContain('/dl/archive/v0.4.0/source.zip');
  });

  it('hides source archives from free-trial members', async () => {
    await publishArtifact('v0.4.1', 'windows', 'windows-v41');
    await publishArtifact('v0.4.1', 'source', 'source-v41');
    const cookie = await downloadSessionCookie('free_trial');

    const response = await worker.fetch(request('/downloads', { headers: { cookie } }), env);
    const html = await response.text();
    const directSource = await worker.fetch(
      request('/dl/archive/v0.4.1/source.zip', { headers: { cookie } }),
      env
    );

    expect(response.status).toBe(200);
    expect(html).toContain('/dl/archive/v0.4.1/windows.zip');
    expect(html).not.toContain('/dl/archive/v0.4.1/source.zip');
    expect(directSource.status).toBe(403);
    expect(await directSource.json()).toEqual({ error: 'standard_required' });
  });

  it('serves immutable archive files and latest aliases to an authorized member', async () => {
    await publishArtifact('v0.5.0', 'windows', 'windows-v5');
    const cookie = await downloadSessionCookie();

    const archive = await worker.fetch(
      request('/dl/archive/v0.5.0/windows.zip', { headers: { cookie } }),
      env
    );
    const latest = await worker.fetch(request('/dl/latest', { headers: { cookie } }), env);

    expect(archive.status).toBe(200);
    expect(new TextDecoder().decode(await archive.arrayBuffer())).toBe('windows-v5');
    expect(archive.headers.get('cache-control')).toBe('private, no-store');
    expect(latest.status).toBe(200);
    expect(new TextDecoder().decode(await latest.arrayBuffer())).toBe('windows-v5');
  });

  it('accepts the 14-day Flutter bearer token for app updates', async () => {
    await publishArtifact('v0.6.0', 'windows', 'windows-v6');
    const token = `aura_${'b'.repeat(64)}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await env.SERVERS.put(
      `app-session:${hash}`,
      JSON.stringify({ discord_id: '987654321', expires_at: Math.floor(Date.now() / 1000) + 86400 })
    );
    await env.SERVERS.put(
      'account:987654321',
      JSON.stringify({
        discord_id: '987654321', username: 'updater', display_name: 'Updater', created_at: 1,
        expires_at: Math.floor(Date.now() / 1000) + 86400, budget_gb: 1, disabled: false, plan: 'free_trial',
      })
    );

    const response = await worker.fetch(
      request('/dl/latest', { headers: { authorization: `Bearer ${token}` } }),
      env
    );

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('windows-v6');
  });

  it('denies source downloads to a free-trial Flutter token', async () => {
    await publishArtifact('v0.6.1', 'source', 'source-v61');
    const token = `aura_${'c'.repeat(64)}`;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    await env.SERVERS.put(
      `app-session:${hash}`,
      JSON.stringify({ discord_id: '987654322', expires_at: Math.floor(Date.now() / 1000) + 86400 })
    );
    await env.SERVERS.put(
      'account:987654322',
      JSON.stringify({
        discord_id: '987654322', username: 'trial-source', display_name: 'Trial Source', created_at: 1,
        expires_at: Math.floor(Date.now() / 1000) + 86400, budget_gb: 1, disabled: false,
        plan: 'free_trial', trial_claimed_at: 1,
      })
    );

    const response = await worker.fetch(
      request('/dl/source', { headers: { authorization: `Bearer ${token}` } }),
      env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'standard_required' });
  });

  it('issues a download session only when Discord returns the required role', async () => {
    const login = await worker.fetch(request('/auth/discord/login?return_to=%2Fdownloads'), env);
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = login.headers.get('set-cookie')!.split(';', 1)[0];
    const outbound = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/oauth2/token')) {
        return Response.json({ access_token: 'discord-access-token', token_type: 'Bearer' });
      }
      if (url.endsWith('/users/@me')) {
        return Response.json({ id: '123456789', username: 'auraking' });
      }
      if (url.endsWith('/users/@me/guilds/discord-guild-id/member')) {
        return Response.json({ roles: ['1544233739322789948'] });
      }
      return new Response('unexpected Discord URL', { status: 500 });
    });
    vi.stubGlobal('fetch', outbound);

    const response = await worker.fetch(
      request(`/auth/discord/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: stateCookie },
      }),
      env
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/downloads');
    expect(response.headers.get('set-cookie')).toContain('aura_download=123456789.');
    expect(outbound).toHaveBeenCalledTimes(3);
  });

  it('denies Discord members who do not have the required role', async () => {
    const login = await worker.fetch(request('/auth/discord/login'), env);
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
    const stateCookie = login.headers.get('set-cookie')!.split(';', 1)[0];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/oauth2/token')) return Response.json({ access_token: 'token' });
        if (url.endsWith('/users/@me')) return Response.json({ id: '123456789', username: 'no-role' });
        return Response.json({ roles: ['some-other-role'] });
      })
    );

    const response = await worker.fetch(
      request(`/auth/discord/callback?code=oauth-code&state=${state}`, {
        headers: { cookie: stateCookie },
      }),
      env
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'required_discord_role' });
    expect(response.headers.get('set-cookie') ?? '').not.toContain('aura_download=');
  });

  it('rejects an OAuth callback whose state does not match the HttpOnly cookie', async () => {
    const response = await worker.fetch(
      request('/auth/discord/callback?code=oauth-code&state=attacker-state', {
        headers: { cookie: 'aura_oauth_state=real-state.9999999999.%2Fdownloads' },
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_oauth_state' });
  });
});

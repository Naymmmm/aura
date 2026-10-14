import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { handleVerifiedDiscordInteraction } from '../src/discord_bot';
import { canonicalLicenseKey, issueLicenseKey } from '../src/licenses';

const staffRole = '800000000000000001';

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://api.copal.run${path}`, init);
}

async function seedAccount(discordId: string, overrides: Record<string, unknown> = {}) {
  await env.SERVERS.put(`account:${discordId}`, JSON.stringify({
    discord_id: discordId,
    username: 'keyuser',
    display_name: 'Key User',
    created_at: 1,
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    budget_gb: 20,
    disabled: false,
    plan: 'standard',
    ...overrides,
  }));
  await env.SERVERS.put(
    'v1',
    JSON.stringify({ version: 1, servers: [{ tag: 'romeo', host: 'romeo.example', ip: '1.2.3.4' }] })
  );
  await env.SERVERS.put('pool', JSON.stringify({ romeo: [{ user: 'u', pass: 'p' }] }));
}

function openWithKey(key: string) {
  return worker.fetch(
    request('/v1/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ license_key: key }),
    }),
    env
  );
}

describe('License keys', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('formats keys as AURA-XXXXX×5 and tolerates sloppy retyping', async () => {
    const key = await issueLicenseKey(env, '910000000000000001');
    expect(key).toMatch(/^AURA(-[0-9A-HJKMNP-TV-Z]{5}){5}$/);
    const canonical = canonicalLicenseKey(key)!;
    expect(canonicalLicenseKey(`  ${key.toLowerCase().replaceAll('-', ' ')} \n`)).toBe(canonical);
    expect(canonicalLicenseKey(canonical.replace(/0/g, 'O').replace(/1/g, 'l'))).toBe(canonical);
    expect(canonicalLicenseKey('AURA-SHORT')).toBeNull();
  });

  it('opens a VPN session with only a license key', async () => {
    await seedAccount('910000000000000002');
    const key = await issueLicenseKey(env, '910000000000000002');

    const response = await openWithKey(key);
    const body = await response.json<{ session_id: string; account: { discord_id: string; plan: string } }>();

    expect(response.status).toBe(200);
    expect(body.session_id).toBeTruthy();
    expect(body.account).toMatchObject({ discord_id: '910000000000000002', plan: 'standard' });
  });

  it('rejects unknown keys and keys replaced by a newer one', async () => {
    await seedAccount('910000000000000003');
    const oldKey = await issueLicenseKey(env, '910000000000000003');
    await issueLicenseKey(env, '910000000000000003');

    expect((await openWithKey(oldKey)).status).toBe(401);
    expect((await openWithKey('AURA-00000-00000-00000-00000-00000')).status).toBe(401);
    expect((await openWithKey('garbage')).status).toBe(401);
  });

  it('still enforces account expiry for a valid key', async () => {
    await seedAccount('910000000000000004', { expires_at: 5 });
    const key = await issueLicenseKey(env, '910000000000000004');

    const response = await openWithKey(key);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'account_expired' });
  });

  it('lets any member run /license and replies privately with the key and a .auralicense file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const response = await handleVerifiedDiscordInteraction(
      {
        type: 2,
        channel_id: 'any',
        member: { user: { id: '910000000000000005', username: 'member' }, roles: [] },
        data: { name: 'license', options: [] },
      },
      env
    );
    const form = await response.formData();
    const payload = JSON.parse(form.get('payload_json') as string);
    const file = form.get('files[0]') as File;
    const key = (await file.text()).trim();

    expect(payload.data.flags).toBe(64);
    expect(file.name).toBe('aura.auralicense');
    expect(payload.data.embeds[0].description).toContain(key);
    expect(canonicalLicenseKey(key)).not.toBeNull();
  });

  it('only lets staff issue a key for someone else', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const interaction = (roles: string[]) => ({
      type: 2,
      channel_id: 'any',
      member: { user: { id: '910000000000000006', username: 'asker' }, roles },
      data: { name: 'license', options: [{ name: 'user', type: 6, value: '910000000000000007' }] },
    });

    const denied = await handleVerifiedDiscordInteraction(interaction([]), env);
    expect(await denied.json()).toMatchObject({ data: { embeds: [{ title: 'Staff Only' }] } });

    const allowed = await handleVerifiedDiscordInteraction(interaction([staffRole]), env);
    expect(allowed.headers.get('content-type')).toContain('multipart/form-data');
    expect(await env.SERVERS.get('license-of:910000000000000007')).toBeTruthy();
  });
});

describe('Admin command registration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('registers the slash commands with the bot token the Worker holds, admin only', async () => {
    const denied = await worker.fetch(request('/v1/admin/commands', { method: 'POST' }), env);
    expect(denied.status).toBe(401);

    const login = await worker.fetch(
      request('/v1/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-admin-password' }),
      }),
      env
    );
    const cookie = login.headers.get('set-cookie')!.split(';', 1)[0];
    const discord = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json(JSON.parse(init.body as string))
    );
    vi.stubGlobal('fetch', discord);

    const response = await worker.fetch(request('/v1/admin/commands', { method: 'POST', headers: { cookie } }), env);
    const [url, init] = discord.mock.calls[0];
    const sent = JSON.parse(init.body as string) as Array<{ name: string }>;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ registered: sent.length });
    expect(url).toBe('https://discord.com/api/v10/applications/discord-client-id/guilds/discord-guild-id/commands');
    expect(init).toMatchObject({ method: 'PUT', headers: { authorization: 'Bot test-bot-token' } });
    expect(sent.map((c) => c.name)).toContain('license');
  });
});

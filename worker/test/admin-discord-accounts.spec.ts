import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

function request(path: string, init?: RequestInit) {
  return new Request(`https://api.copal.run${path}`, init);
}

async function adminCookie(): Promise<string> {
  const response = await worker.fetch(
    request('/v1/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-admin-password' }),
    }),
    env
  );
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}

describe('Discord account admin fallback', () => {
  it('lists and edits Discord-ID accounts instead of legacy generated credentials', async () => {
    const id = '910000000000000001';
    await env.SERVERS.put(
      `account:${id}`,
      JSON.stringify({
        discord_id: id, username: 'adminview', display_name: 'Admin View', created_at: 1,
        expires_at: 10, budget_gb: 1, disabled: false, plan: 'free_trial', trial_claimed_at: 1,
      })
    );
    const cookie = await adminCookie();

    const list = await worker.fetch(request('/v1/admin/accounts', { headers: { cookie } }), env);
    expect(await list.json()).toMatchObject({
      accounts: [expect.objectContaining({ id, name: 'Admin View', plan: 'free_trial' })],
    });

    const extend = await worker.fetch(
      request(`/v1/admin/accounts/${id}/extend`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ days: 3 }),
      }),
      env
    );
    expect(extend.status).toBe(200);
    const account = await env.SERVERS.get(`account:${id}`, 'json') as { expires_at: number; plan: string };
    expect(account.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 2 * 86400);
    expect(account.plan).toBe('standard');
  });

  it('disables legacy account creation because Discord is the identity source', async () => {
    const cookie = await adminCookie();
    const response = await worker.fetch(
      request('/v1/admin/accounts', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'legacy' }),
      }),
      env
    );

    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: 'discord_identity_required' });
  });

  it('removes generated-ID account creation from the admin page', async () => {
    const response = await worker.fetch(request('/admin'), env);
    const html = await response.text();

    expect(html).toContain('Discord accounts');
    expect(html).not.toContain('Create account');
    expect(html).not.toContain('api token');
  });
});

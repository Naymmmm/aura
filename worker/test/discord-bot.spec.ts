import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { creditDaysForAud, handleVerifiedDiscordInteraction, reconcileExpiredAccountRoles, verifyDiscordInteraction } from '../src/discord_bot';
const staffRole = '800000000000000001';
const trialChannel = '700000000000000001';

function member(id: string, roles: string[] = []) {
  return { user: { id, username: `user_${id.slice(-4)}`, global_name: `User ${id.slice(-4)}` }, roles };
}

function command(name: string, options: unknown[] = [], roles = [staffRole]) {
  return {
    type: 2,
    channel_id: trialChannel,
    member: member('600000000000000001', roles),
    data: { name, options },
  };
}

describe('Aura Discord bot', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rejects unsigned Discord interaction webhooks', async () => {
    const response = await worker.fetch(
      new Request('https://api.copal.run/v1/discord/interactions', {
        method: 'POST',
        body: JSON.stringify({ type: 1 }),
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it('verifies Discord Ed25519 request signatures over timestamp plus raw body', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    if (!('privateKey' in pair)) throw new Error('Ed25519 key generation did not return a key pair');
    const body = JSON.stringify({ type: 1 });
    const timestamp = '1770000000';
    const bytes = new TextEncoder().encode(timestamp + body);
    const signature = await crypto.subtle.sign('Ed25519', pair.privateKey, bytes);
    const publicKey = await crypto.subtle.exportKey('raw', pair.publicKey);
    if (!(publicKey instanceof ArrayBuffer)) throw new Error('Ed25519 raw public key was not binary');
    const hex = (value: ArrayBuffer) =>
      [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

    expect(await verifyDiscordInteraction(body, timestamp, hex(signature), hex(publicKey))).toBe(true);
    expect(await verifyDiscordInteraction(body + ' ', timestamp, hex(signature), hex(publicKey))).toBe(false);
  });

  it('posts the green free-trial claim embed only in the configured trial channel', async () => {
    const response = await handleVerifiedDiscordInteraction(command('trial-panel'), env);
    const body = await response.json<{
      type: number;
      data: { embeds: Array<{ title: string; color: number }>; components: Array<{ components: unknown[] }> };
    }>();

    expect(response.status).toBe(200);
    expect(body.type).toBe(4);
    expect(body.data.embeds[0]).toMatchObject({ title: 'Free Trial', color: 0x00e676 });
    expect(body.data.components[0].components).toContainEqual(
      expect.objectContaining({ type: 2, custom_id: 'aura:trial:claim', label: 'Start Free Trial' })
    );

    const wrongChannel = await handleVerifiedDiscordInteraction(
      { ...command('trial-panel'), channel_id: 'wrong-channel' },
      env
    );
    expect(await wrongChannel.json()).toMatchObject({ data: { flags: 64 } });
  });

  it('claims a free trial once with 7 days, 1GB, a role grant, and an audit log', async () => {
    const discordId = '600000000000000010';
    const outbound = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', outbound);

    const response = await handleVerifiedDiscordInteraction(
      {
        type: 3,
        channel_id: trialChannel,
        member: member(discordId),
        data: { custom_id: 'aura:trial:claim', component_type: 2 },
      },
      env
    );
    const account = await env.SERVERS.get(`account:${discordId}`, 'json') as {
      plan: string;
      budget_gb: number;
      expires_at: number;
      trial_claimed_at: number;
    };
    const audits = await env.SERVERS.list({ prefix: 'audit:' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: 4,
      data: { flags: 64, embeds: [expect.objectContaining({ title: 'Free Trial Activated' })] },
    });
    expect(account.plan).toBe('free_trial');
    expect(account.budget_gb).toBe(1);
    expect(account.expires_at - account.trial_claimed_at).toBe(7 * 86400);
    expect(audits.keys.length).toBeGreaterThan(0);
    // Free trial does not carry the customer role.
    expect(outbound).toHaveBeenCalledWith(
      expect.stringContaining(`/guilds/discord-guild-id/members/${discordId}/roles/1544233739322789948`),
      expect.objectContaining({ method: 'DELETE' })
    );

    const replay = await handleVerifiedDiscordInteraction(
      {
        type: 3,
        channel_id: trialChannel,
        member: member(discordId),
        data: { custom_id: 'aura:trial:claim', component_type: 2 },
      },
      env
    );
    expect(await replay.json()).toMatchObject({
      data: { embeds: [expect.objectContaining({ title: 'Trial Already Claimed' })] },
    });
  });

  it('lets staff add/remove days, add budget, and replenish a free trial', async () => {
    const target = '600000000000000020';
    await env.SERVERS.put(
      `account:${target}`,
      JSON.stringify({
        discord_id: target,
        username: 'managed',
        display_name: 'Managed User',
        created_at: 1,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        budget_gb: 1,
        disabled: false,
        plan: 'free_trial',
        trial_claimed_at: 1,
      })
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    const userOption = { name: 'user', type: 6, value: target };
    const addDays = await handleVerifiedDiscordInteraction(
      command('days', [
        { name: 'action', type: 3, value: 'add' },
        userOption,
        { name: 'amount', type: 4, value: 10 },
      ]),
      env
    );
    expect(await addDays.json()).toMatchObject({ data: { embeds: [expect.objectContaining({ title: 'Days Added' })] } });

    await handleVerifiedDiscordInteraction(
      command('days', [
        { name: 'action', type: 3, value: 'remove' },
        userOption,
        { name: 'amount', type: 4, value: 3 },
      ]),
      env
    );
    await handleVerifiedDiscordInteraction(
      command('budget', [userOption, { name: 'amount', type: 10, value: 4 }]),
      env
    );
    await handleVerifiedDiscordInteraction(command('trial-replenish', [userOption]), env);

    const account = await env.SERVERS.get(`account:${target}`, 'json') as {
      plan: string;
      budget_gb: number;
      expires_at: number;
    };
    expect(account.plan).toBe('free_trial');
    expect(account.budget_gb).toBe(6);
    expect(account.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 14 * 86400);
  });

  it('converts AUD credits into days with a 10% discount for three months or more', () => {
    expect(creditDaysForAud(1.99)).toBeNull();
    expect(creditDaysForAud(2)).toEqual({ days: 30, discounted: false, effectiveMonthlyAud: 2 });
    expect(creditDaysForAud(4)).toEqual({ days: 60, discounted: false, effectiveMonthlyAud: 2 });
    expect(creditDaysForAud(5.4)).toEqual({ days: 90, discounted: true, effectiveMonthlyAud: 1.8 });
    expect(creditDaysForAud(9)).toEqual({ days: 150, discounted: true, effectiveMonthlyAud: 1.8 });
  });

  it('upgrades an Aura account to Standard for 30 days', async () => {
    const target = '600000000000000025';
    await env.SERVERS.put(
      `account:${target}`,
      JSON.stringify({
        discord_id: target, username: 'upgrade', display_name: 'Upgrade Me', created_at: 1,
        expires_at: 0, budget_gb: 1, disabled: false, plan: 'none',
      })
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    const response = await handleVerifiedDiscordInteraction(
      command('upgrade', [{ name: 'user', type: 6, value: target }]),
      env
    );
    const account = await env.SERVERS.get(`account:${target}`, 'json') as { plan: string; expires_at: number };

    expect(account.plan).toBe('standard');
    expect(account.expires_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 30 * 86400 - 2);
    expect(await response.json()).toMatchObject({
      data: { embeds: [expect.objectContaining({ title: 'Upgraded to Standard' })] },
    });
  });

  it('adds Standard days from an AUD credit amount', async () => {
    const target = '600000000000000026';
    await env.SERVERS.put(
      `account:${target}`,
      JSON.stringify({
        discord_id: target, username: 'credits', display_name: 'Credits User', created_at: 1,
        expires_at: 0, budget_gb: 1, disabled: false, plan: 'free_trial', trial_claimed_at: 1,
      })
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    const response = await handleVerifiedDiscordInteraction(
      command('credits', [
        { name: 'user', type: 6, value: target },
        { name: 'aud', type: 10, value: 5.4 },
      ]),
      env
    );
    const account = await env.SERVERS.get(`account:${target}`, 'json') as { plan: string; expires_at: number };

    expect(account.plan).toBe('standard');
    expect(account.expires_at).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 90 * 86400 - 2);
    const body = await response.json<{ data: { embeds: Array<{ description: string }> } }>();
    expect(body.data.embeds[0].description).toContain('**A$5.40**');
    expect(body.data.embeds[0].description).toContain('**90 days**');
    expect(body.data.embeds[0].description).toContain('10%');
  });

  it('denies entitlement commands to members without the staff role', async () => {
    const response = await handleVerifiedDiscordInteraction(
      command('budget', [{ name: 'user', type: 6, value: '123' }, { name: 'amount', type: 10, value: 1 }], []),
      env
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { flags: 64, embeds: [expect.objectContaining({ title: 'Staff Only' })] },
    });
  });

  it('shows staff the current account and persisted audit history', async () => {
    const target = '600000000000000030';
    await env.SERVERS.put(
      `account:${target}`,
      JSON.stringify({
        discord_id: target,
        username: 'audited',
        display_name: 'Audited User',
        created_at: 1,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        budget_gb: 2,
        disabled: false,
        plan: 'free_trial',
        trial_claimed_at: 1,
      })
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const userOption = { name: 'user', type: 6, value: target };
    await handleVerifiedDiscordInteraction(
      command('days', [{ name: 'action', type: 3, value: 'add' }, userOption, { name: 'amount', type: 4, value: 2 }]),
      env
    );

    const account = await handleVerifiedDiscordInteraction(command('account', [userOption]), env);
    const logs = await handleVerifiedDiscordInteraction(command('logs', [userOption]), env);

    expect(await account.json()).toMatchObject({
      data: { embeds: [expect.objectContaining({ title: 'Aura Account' })] },
    });
    const logBody = await logs.json<{ data: { embeds: Array<{ title: string; description: string }> } }>();
    expect(logBody.data.embeds[0].title).toBe('Aura Audit Log');
    expect(logBody.data.embeds[0].description).toContain('days added');
  });

  it('removes the customer role and downgrades Standard when an account expires naturally', async () => {
    const target = '600000000000000040';
    await env.SERVERS.put(
      `account:${target}`,
      JSON.stringify({
        discord_id: target, username: 'expired', display_name: 'Expired User', created_at: 1,
        expires_at: 1, budget_gb: 1, disabled: false, plan: 'standard', trial_claimed_at: 1,
      })
    );
    const outbound = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', outbound);

    const removed = await reconcileExpiredAccountRoles(env);

    expect(removed).toBeGreaterThan(0);
    expect(outbound).toHaveBeenCalledWith(
      expect.stringContaining(`/members/${target}/roles/1544233739322789948`),
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(await env.SERVERS.get(`account:${target}`, 'json')).toMatchObject({ plan: 'none' });
  });

  it('does not grant the customer role for a free-trial claim', async () => {
    const target = '600000000000000050';
    const outbound = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/channels/')
        ? new Response('missing log channel', { status: 404 })
        : new Response(null, { status: 204 })
    );
    vi.stubGlobal('fetch', outbound);

    const response = await handleVerifiedDiscordInteraction(
      {
        type: 3,
        channel_id: trialChannel,
        member: member(target),
        data: { custom_id: 'aura:trial:claim', component_type: 2 },
      },
      env
    );

    expect(response.status).toBe(200);
    // Free trial no longer grants the customer role — it is removed, not PUT.
    expect(outbound).toHaveBeenCalledWith(
      expect.stringContaining(`/members/${target}/roles/1544233739322789948`),
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});

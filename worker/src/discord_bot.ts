import { getDiscordAccount, putDiscordAccount, upsertDiscordIdentity } from './accounts_v2';
import type { DiscordAccount } from './accounts_v2';
import { nowSec } from './util';

const DISCORD_API = 'https://discord.com/api/v10';
const EPHEMERAL = 64;
const GREEN = 0x00e676;
const RED = 0xed4245;
const BLUE = 0x5865f2;
const AMBER = 0xfaa61a;

export async function reconcileExpiredAccountRoles(env: Env): Promise<number> {
  const listed = await env.SERVERS.list({ prefix: 'account:', limit: 1000 });
  const accounts = await Promise.all(listed.keys.map((key) => getDiscordAccount(env, key.name.slice(8))));
  let removed = 0;
  for (const account of accounts) {
    if (account && (account.disabled || account.expires_at <= nowSec() || account.budget_gb <= 0)) {
      if ((account.plan === 'standard' || account.plan === 'paid') && account.expires_at <= nowSec()) {
        account.plan = 'none';
        account.updated_at = nowSec();
        await putDiscordAccount(env, account);
        console.log(JSON.stringify({ message: 'Aura Standard expired', target_id: account.discord_id }));
      }
      await syncCustomerRole(env, account);
      removed++;
    }
  }
  console.log(JSON.stringify({ message: 'Aura role reconciliation', checked: accounts.length, removed }));
  return removed;
}

interface Actor { id: string; username: string; displayName: string; roles: string[] }

function hexBytes(hex: string): Uint8Array | null {
  if (!/^[a-fA-F0-9]+$/.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export async function verifyDiscordInteraction(body: string, timestamp: string, signature: string, publicKey: string): Promise<boolean> {
  const signatureBytes = hexBytes(signature);
  const publicKeyBytes = hexBytes(publicKey);
  if (!signatureBytes || !publicKeyBytes || publicKeyBytes.length !== 32) return false;
  try {
    const key = await crypto.subtle.importKey('raw', publicKeyBytes, { name: 'Ed25519' }, false, ['verify']);
    return crypto.subtle.verify('Ed25519', key, signatureBytes, new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

export async function handleDiscordInteraction(req: Request, env: Env): Promise<Response> {
  const signature = req.headers.get('x-signature-ed25519') ?? '';
  const timestamp = req.headers.get('x-signature-timestamp') ?? '';
  if (!signature || !timestamp) return new Response('invalid request signature', { status: 401 });
  const body = await req.text();
  if (!(await verifyDiscordInteraction(body, timestamp, signature, env.DISCORD_PUBLIC_KEY))) {
    return new Response('invalid request signature', { status: 401 });
  }
  try {
    return handleVerifiedDiscordInteraction(JSON.parse(body) as unknown, env);
  } catch {
    return new Response('bad request', { status: 400 });
  }
}

export async function handleVerifiedDiscordInteraction(interaction: unknown, env: Env): Promise<Response> {
  const type = numberProperty(interaction, 'type');
  if (type === 1) return discordResponse({ type: 1 });
  const actor = interactionActor(interaction);
  if (!actor) return message('Discord Account Required', 'Run this inside the Aura Discord server.', RED);
  const channelId = stringProperty(interaction, 'channel_id');
  const data = objectProperty(interaction, 'data');

  if (type === 3 && stringProperty(data, 'custom_id') === 'aura:trial:claim') {
    if (channelId !== env.DISCORD_TRIAL_CHANNEL_ID) return message('Wrong Channel', 'Claim the trial from the official free-trial channel.', RED);
    return claimTrial(env, actor);
  }
  if (type !== 2) return message('Unknown Action', 'That Aura action is not supported.', RED);
  const commandName = stringProperty(data, 'name');
  if (!actor.roles.includes(env.DISCORD_STAFF_ROLE_ID)) {
    return message('Staff Only', 'You do not have the Aura staff role required for this command.', RED);
  }
  if (commandName === 'trial-panel') {
    if (channelId !== env.DISCORD_TRIAL_CHANNEL_ID) return message('Wrong Channel', 'Post this panel in the configured free-trial channel.', RED);
    return discordResponse({
      type: 4,
      data: {
        embeds: [{
          title: 'Free Trial',
          description: 'Try Aura VPN free for **7 days** with **1 GB** of data. Click below to activate it on your Discord account.',
          color: GREEN,
          footer: { text: 'Aura VPN • one trial per member' },
        }],
        components: [{ type: 1, components: [{ type: 2, style: 3, custom_id: 'aura:trial:claim', label: 'Start Free Trial', emoji: { name: '✨' } }] }],
        allowed_mentions: { parse: [] },
      },
    });
  }
  if (commandName === 'days') return manageDays(interaction, env, actor);
  if (commandName === 'upgrade') return upgradeStandard(interaction, env, actor);
  if (commandName === 'credits') return addCredits(interaction, env, actor);
  if (commandName === 'budget') return manageBudget(interaction, env, actor);
  if (commandName === 'trial-replenish') return replenishTrial(interaction, env, actor);
  if (commandName === 'account') return showAccount(interaction, env);
  if (commandName === 'logs') return showLogs(interaction, env);
  return message('Unknown Command', 'Register the latest Aura application commands.', RED);
}

async function getOrCreateAccount(env: Env, discordId: string): Promise<DiscordAccount> {
  const existing = await getDiscordAccount(env, discordId);
  if (existing) return existing;
  // Allow staff to grant premium to a Discord member who has never signed in or
  // claimed a trial — no prior account required. Identity details are filled in
  // when the member next signs in with Discord.
  return {
    discord_id: discordId,
    username: `member-${discordId.slice(-6)}`,
    display_name: `Member ${discordId}`,
    created_at: nowSec(),
    expires_at: 0,
    budget_gb: 0,
    disabled: false,
    plan: 'none',
  };
}

async function claimTrial(env: Env, actor: Actor): Promise<Response> {
  const existing = await getDiscordAccount(env, actor.id);
  if (existing?.trial_claimed_at) return message('Trial Already Claimed', 'This Discord account has already used its Aura free trial.', AMBER);
  const account = await upsertDiscordIdentity(env, { discordId: actor.id, username: actor.username, displayName: actor.displayName });
  const claimedAt = nowSec();
  account.plan = 'free_trial';
  account.trial_claimed_at = claimedAt;
  account.expires_at = claimedAt + 7 * 86400;
  account.budget_gb = 1;
  account.disabled = false;
  account.updated_at = claimedAt;
  await putDiscordAccount(env, account);
  await recordAudit(env, 'trial_claimed', actor, account, { days: 7, budget_gb: 1 });
  await syncCustomerRole(env, account);
  return message('Free Trial Activated', `Your **7-day / 1 GB** Aura trial is live. Sign in to the Aura app with Discord to connect.\n\nExpires <t:${account.expires_at}:R>.`, GREEN);
}

async function manageDays(interaction: unknown, env: Env, actor: Actor): Promise<Response> {
  const targetId = optionString(interaction, 'user');
  const action = optionString(interaction, 'action');
  const amount = optionNumber(interaction, 'amount');
  if (!targetId || (action !== 'add' && action !== 'remove') || !amount || amount <= 0 || amount > 3650) {
    return message('Invalid Days', 'Choose add/remove, a Discord user, and 1–3650 days.', RED);
  }
  const account = action === 'add'
    ? await getOrCreateAccount(env, targetId)
    : await getDiscordAccount(env, targetId);
  if (!account) return message('Account Not Found', 'That member must sign in or claim a trial first.', RED);
  const seconds = Math.floor(amount) * 86400;
  account.expires_at = action === 'add' ? Math.max(nowSec(), account.expires_at) + seconds : Math.max(0, account.expires_at - seconds);
  if (action === 'add') account.plan = 'standard';
  account.updated_at = nowSec();
  await putDiscordAccount(env, account);
  await recordAudit(env, action === 'add' ? 'days_added' : 'days_removed', actor, account, { days: Math.floor(amount) });
  await syncCustomerRole(env, account);
  return message(action === 'add' ? 'Days Added' : 'Days Removed', `<@${targetId}> now expires <t:${account.expires_at}:F> (<t:${account.expires_at}:R>).`, action === 'add' ? GREEN : AMBER);
}

export function creditDaysForAud(aud: number): { days: number; discounted: boolean; effectiveMonthlyAud: number } | null {
  if (!Number.isFinite(aud) || aud < 2) return null;
  const discounted = aud >= 5.4;
  const effectiveMonthlyAud = discounted ? 1.8 : 2;
  return {
    days: Math.floor((aud / effectiveMonthlyAud) * 30 + 1e-9),
    discounted,
    effectiveMonthlyAud,
  };
}

async function upgradeStandard(interaction: unknown, env: Env, actor: Actor): Promise<Response> {
  const targetId = optionString(interaction, 'user');
  if (!targetId) return message('Invalid Member', 'Choose the Aura member to upgrade.', RED);
  const account = await getOrCreateAccount(env, targetId);
  account.plan = 'standard';
  account.expires_at = Math.max(nowSec(), account.expires_at) + 30 * 86400;
  account.disabled = false;
  account.updated_at = nowSec();
  await putDiscordAccount(env, account);
  await recordAudit(env, 'standard_upgraded', actor, account, { days: 30, aud: 2 });
  await syncCustomerRole(env, account);
  return message('Upgraded to Standard', `<@${targetId}> received **30 days** of Standard Aura.\n\nExpires <t:${account.expires_at}:F> (<t:${account.expires_at}:R>).`, GREEN);
}

async function addCredits(interaction: unknown, env: Env, actor: Actor): Promise<Response> {
  const targetId = optionString(interaction, 'user');
  const aud = optionNumber(interaction, 'aud');
  const conversion = aud === null ? null : creditDaysForAud(aud);
  if (!targetId || !conversion || aud === null || aud > 10000) {
    return message('Invalid Credits', 'Choose a member and add at least **A$2.00**.', RED);
  }
  const account = await getOrCreateAccount(env, targetId);
  account.plan = 'standard';
  account.expires_at = Math.max(nowSec(), account.expires_at) + conversion.days * 86400;
  account.disabled = false;
  account.updated_at = nowSec();
  await putDiscordAccount(env, account);
  await recordAudit(env, 'credits_added', actor, account, { aud, days: conversion.days });
  await syncCustomerRole(env, account);
  const discount = conversion.discounted ? '\nBulk rate: **10% off** (A$1.80 / 30 days).' : '';
  return message(
    'Standard Credits Added',
    `<@${targetId}>: **A$${aud.toFixed(2)}** converted to **${conversion.days} days**.${discount}\n\nExpires <t:${account.expires_at}:F> (<t:${account.expires_at}:R>).`,
    GREEN
  );
}

async function manageBudget(interaction: unknown, env: Env, actor: Actor): Promise<Response> {
  const targetId = optionString(interaction, 'user');
  const amount = optionNumber(interaction, 'amount');
  if (!targetId || !amount || amount <= 0 || amount > 10000) return message('Invalid Budget', 'Choose a Discord user and 0–10,000 GB to add.', RED);
  const account = await getDiscordAccount(env, targetId);
  if (!account) return message('Account Not Found', 'That member must sign in or claim a trial first.', RED);
  account.budget_gb += amount;
  account.updated_at = nowSec();
  await putDiscordAccount(env, account);
  await recordAudit(env, 'budget_added', actor, account, { budget_gb: amount });
  return message('Budget Added', `<@${targetId}> now has **${account.budget_gb} GB**.`, BLUE);
}

async function replenishTrial(interaction: unknown, env: Env, actor: Actor): Promise<Response> {
  const targetId = optionString(interaction, 'user');
  if (!targetId) return message('Invalid Member', 'Choose the free-trial member to replenish.', RED);
  const account = await getDiscordAccount(env, targetId);
  if (!account) return message('Account Not Found', 'That member must sign in or claim a trial first.', RED);
  account.plan = 'free_trial';
  account.trial_claimed_at ??= nowSec();
  account.expires_at = Math.max(nowSec(), account.expires_at) + 7 * 86400;
  account.budget_gb += 1;
  account.disabled = false;
  account.updated_at = nowSec();
  await putDiscordAccount(env, account);
  await recordAudit(env, 'trial_replenished', actor, account, { days: 7 });
  await syncCustomerRole(env, account);
  return message('Trial Replenished', `<@${targetId}> received another **7 days**.`, GREEN);
}

async function showAccount(interaction: unknown, env: Env): Promise<Response> {
  const targetId = optionString(interaction, 'user');
  if (!targetId) return message('Invalid Member', 'Choose the Aura member to inspect.', RED);
  const account = await getDiscordAccount(env, targetId);
  if (!account) return message('Account Not Found', 'That member has no Aura account.', RED);
  return message(
    'Aura Account',
    `Member: <@${targetId}>\nPlan: **${account.plan.replace('_', ' ')}**\nBudget: **${account.budget_gb} GB**\nExpires: ${account.expires_at ? `<t:${account.expires_at}:F> (<t:${account.expires_at}:R>)` : '**no credit**'}\nDisabled: **${account.disabled ? 'yes' : 'no'}**`,
    BLUE
  );
}

async function showLogs(interaction: unknown, env: Env): Promise<Response> {
  const targetId = optionString(interaction, 'user');
  if (!targetId) return message('Invalid Member', 'Choose the Aura member whose logs you need.', RED);
  const listed = await env.SERVERS.list({ prefix: 'audit:', limit: 100 });
  const entries = await Promise.all(listed.keys.map((key) => env.SERVERS.get(key.name, 'json')));
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const target = stringProperty(entry, 'target_id');
    const action = stringProperty(entry, 'action');
    const timestamp = numberProperty(entry, 'timestamp');
    const actorId = stringProperty(entry, 'actor_id');
    if (target === targetId && action && timestamp && actorId) {
      lines.push(`• <t:${timestamp}:R> **${action.replaceAll('_', ' ')}** by <@${actorId}>`);
      if (lines.length === 10) break;
    }
  }
  return message('Aura Audit Log', lines.join('\n') || 'No account changes have been logged for this member.', BLUE);
}

async function recordAudit(env: Env, action: string, actor: Actor, account: DiscordAccount, change: Record<string, number>): Promise<void> {
  const timestamp = nowSec();
  const key = `audit:${String(9999999999 - timestamp).padStart(10, '0')}:${crypto.randomUUID()}`;
  const audit = { timestamp, action, actor_id: actor.id, target_id: account.discord_id, change, account: { expires_at: account.expires_at, budget_gb: account.budget_gb, plan: account.plan } };
  await env.SERVERS.put(key, JSON.stringify(audit));
  console.log(JSON.stringify({ message: 'Aura account audit', ...audit }));
  if (env.DISCORD_LOG_CHANNEL_ID && env.DISCORD_BOT_TOKEN) {
    try {
      await discordBotRequest(env, `/channels/${env.DISCORD_LOG_CHANNEL_ID}/messages`, 'POST', {
        embeds: [{ title: action.replaceAll('_', ' '), description: `Actor: <@${actor.id}>\nMember: <@${account.discord_id}>\nPlan: **${account.plan}**\nBudget: **${account.budget_gb} GB**\nExpires: <t:${account.expires_at}:F>`, color: BLUE, timestamp: new Date(timestamp * 1000).toISOString() }],
        allowed_mentions: { parse: [] },
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: 'Aura Discord audit mirror failed',
        action,
        target_id: account.discord_id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

async function syncCustomerRole(env: Env, account: DiscordAccount): Promise<void> {
  // Only paying customers carry the "customer" role. Free-trial accounts don't
  // get it, and download access is entitlement-based (DB), not role-based.
  const active = !account.disabled && account.expires_at > nowSec() && account.budget_gb > 0 && (account.plan === 'standard' || account.plan === 'paid');
  await discordBotRequest(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${account.discord_id}/roles/${env.DISCORD_REQUIRED_ROLE_ID}`, active ? 'PUT' : 'DELETE');
}

async function discordBotRequest(env: Env, path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<void> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Discord bot API ${response.status}`);
}

function discordResponse(value: unknown): Response { return Response.json(value, { headers: { 'cache-control': 'no-store' } }); }

function message(title: string, description: string, color: number): Response {
  return discordResponse({ type: 4, data: { flags: EPHEMERAL, embeds: [{ title, description, color, footer: { text: 'Aura VPN' } }], allowed_mentions: { parse: [] } } });
}

function objectProperty(value: unknown, property: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || !(property in value)) return null;
  const nested = value[property as keyof typeof value];
  return nested && typeof nested === 'object' ? nested as Record<string, unknown> : null;
}

function stringProperty(value: unknown, property: string): string | null {
  if (!value || typeof value !== 'object' || !(property in value)) return null;
  const nested = value[property as keyof typeof value];
  return typeof nested === 'string' ? nested : null;
}

function numberProperty(value: unknown, property: string): number | null {
  if (!value || typeof value !== 'object' || !(property in value)) return null;
  const nested = value[property as keyof typeof value];
  return typeof nested === 'number' ? nested : null;
}

function interactionActor(interaction: unknown): Actor | null {
  const member = objectProperty(interaction, 'member');
  const user = objectProperty(member, 'user');
  const id = stringProperty(user, 'id');
  const username = stringProperty(user, 'username');
  if (!id || !username || !/^\d+$/.test(id)) return null;
  const rawRoles = member && 'roles' in member && Array.isArray(member.roles) ? member.roles : [];
  return { id, username, displayName: stringProperty(user, 'global_name') ?? username, roles: rawRoles.filter((role): role is string => typeof role === 'string') };
}

function interactionOptions(interaction: unknown): unknown[] {
  const data = objectProperty(interaction, 'data');
  return data && 'options' in data && Array.isArray(data.options) ? data.options : [];
}

function optionString(interaction: unknown, name: string): string | null {
  const option = interactionOptions(interaction).find((item) => stringProperty(item, 'name') === name);
  return stringProperty(option, 'value');
}

function optionNumber(interaction: unknown, name: string): number | null {
  const option = interactionOptions(interaction).find((item) => stringProperty(item, 'name') === name);
  return numberProperty(option, 'value');
}

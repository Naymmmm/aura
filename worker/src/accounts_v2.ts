import { nowSec } from './util';

export type AccountPlan = 'none' | 'free_trial' | 'standard' | 'paid';

export interface DiscordAccount {
  discord_id: string;
  username: string;
  display_name: string;
  created_at: number;
  expires_at: number;
  budget_gb: number;
  disabled: boolean;
  plan: AccountPlan;
  trial_claimed_at?: number;
  updated_at?: number;
}

export function accountKey(discordId: string): string {
  return `account:${discordId}`;
}

export async function getDiscordAccount(env: Env, discordId: string): Promise<DiscordAccount | null> {
  const value = await env.SERVERS.get(accountKey(discordId), 'json');
  return isDiscordAccount(value) ? value : null;
}

export async function putDiscordAccount(env: Env, account: DiscordAccount): Promise<void> {
  await env.SERVERS.put(accountKey(account.discord_id), JSON.stringify(account));
}

export async function upsertDiscordIdentity(
  env: Env,
  identity: { discordId: string; username: string; displayName: string }
): Promise<DiscordAccount> {
  const existing = await getDiscordAccount(env, identity.discordId);
  const account: DiscordAccount = existing ?? {
    discord_id: identity.discordId,
    username: identity.username,
    display_name: identity.displayName,
    created_at: nowSec(),
    expires_at: 0,
    budget_gb: 0,
    disabled: false,
    plan: 'none',
  };
  account.username = identity.username;
  account.display_name = identity.displayName;
  account.updated_at = nowSec();
  await putDiscordAccount(env, account);
  return account;
}

function isDiscordAccount(value: unknown): value is DiscordAccount {
  return !!(
    value &&
    typeof value === 'object' &&
    'discord_id' in value &&
    typeof value.discord_id === 'string' &&
    /^\d+$/.test(value.discord_id) &&
    'username' in value &&
    typeof value.username === 'string' &&
    'display_name' in value &&
    typeof value.display_name === 'string' &&
    'created_at' in value &&
    typeof value.created_at === 'number' &&
    'expires_at' in value &&
    typeof value.expires_at === 'number' &&
    'budget_gb' in value &&
    typeof value.budget_gb === 'number' &&
    'disabled' in value &&
    typeof value.disabled === 'boolean' &&
    'plan' in value &&
    (value.plan === 'none' || value.plan === 'free_trial' || value.plan === 'standard' || value.plan === 'paid')
  );
}

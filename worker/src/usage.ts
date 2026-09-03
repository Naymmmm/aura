// Server-side monthly data budget per account.
//
// The tunnel traffic flows to the NaiveProxy servers directly (never through
// this Worker), so the Worker cannot see bytes on its own — the app/aura-core
// must REPORT the usage delta (see the heartbeat endpoint). Once reported, the
// Worker refuses to issue fresh creds when an account is over its monthly
// budget, so a user can no longer "just eat it all up".
//
// KV keys (SERVERS binding): `usage:<account_id>:<YYYY-MM>` → bytes.

import { nowSec } from './util';

const GB = 1024 * 1024 * 1024;

function monthKey(now: number): string {
  const d = new Date(now * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function usageKey(accountId: string, now: number = nowSec()): string {
  return `usage:${accountId}:${monthKey(now)}`;
}

/** Bytes used by an account so far this calendar month. */
export async function getMonthBytes(env: Env, accountId: string): Promise<number> {
  const raw = await env.SERVERS.get(usageKey(accountId));
  const n = parseInt(raw ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

/** Add a positive byte delta to the account's current month. */
export async function addUsage(env: Env, accountId: string, delta: number): Promise<void> {
  if (!Number.isFinite(delta) || delta <= 0) return;
  const key = usageKey(accountId);
  const prev = parseInt((await env.SERVERS.get(key)) ?? '0', 10) || 0;
  await env.SERVERS.put(key, String(prev + Math.floor(delta)));
}

export function budgetBytes(gb: number): number {
  return Math.max(0, gb) * GB;
}

/** True when an account has already consumed its monthly budget. */
export async function overBudget(env: Env, accountId: string, budgetGb: number): Promise<boolean> {
  if (budgetGb <= 0) return false;
  return (await getMonthBytes(env, accountId)) >= budgetBytes(budgetGb);
}

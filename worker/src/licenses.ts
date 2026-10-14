// License keys: a Discord-free way for the app to sign in from filtered
// networks. A key is bound to a Discord account record (plan, expiry, budget
// all still live there); members fetch it once with the `/license` bot
// command from any unfiltered device, then the app only ever talks to
// api.copal.run. One active key per account — issuing a new key revokes the
// old one.
// KV keys (SERVERS binding):
//   license:<sha256(canonical key)> — {discord_id, created_at}
//   license-of:<discord_id>         — sha256 of that account's active key

import { getDiscordAccount } from './accounts_v2';
import type { DiscordAccount } from './accounts_v2';
import { nowSec, sha256Hex } from './util';

// Crockford base32: no I, L, O or U, so keys survive being read aloud or retyped.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUPS = 5;
const GROUP_LEN = 5; // 25 chars × 5 bits = 125 bits of entropy

interface LicenseRecord {
  discord_id: string;
  created_at: number;
}

/** Strip formatting and fold look-alike characters; null when it can't be a key. */
export function canonicalLicenseKey(input: string): string | null {
  let s = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.startsWith('AURA')) s = s.slice(4);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== GROUPS * GROUP_LEN) return null;
  for (const c of s) if (!ALPHABET.includes(c)) return null;
  return s;
}

function formatKey(canonical: string): string {
  const groups: string[] = [];
  for (let i = 0; i < canonical.length; i += GROUP_LEN) groups.push(canonical.slice(i, i + GROUP_LEN));
  return `AURA-${groups.join('-')}`;
}

/** Issue a fresh key for an account, revoking its previous key. Returns the display form. */
export async function issueLicenseKey(env: Env, discordId: string): Promise<string> {
  const bytes = new Uint8Array(GROUPS * GROUP_LEN);
  crypto.getRandomValues(bytes);
  const canonical = Array.from(bytes, (b) => ALPHABET[b & 31]).join('');
  const hash = await sha256Hex(canonical);
  const previous = await env.SERVERS.get(`license-of:${discordId}`);
  const record: LicenseRecord = { discord_id: discordId, created_at: nowSec() };
  await Promise.all([
    env.SERVERS.put(`license:${hash}`, JSON.stringify(record)),
    env.SERVERS.put(`license-of:${discordId}`, hash),
    ...(previous && previous !== hash ? [env.SERVERS.delete(`license:${previous}`)] : []),
  ]);
  return formatKey(canonical);
}

/** Resolve a key (any formatting) to its account, or null if unknown/revoked. */
export async function authenticateLicenseKey(env: Env, key: string): Promise<DiscordAccount | null> {
  const canonical = canonicalLicenseKey(key);
  if (!canonical) return null;
  const value = await env.SERVERS.get(`license:${await sha256Hex(canonical)}`, 'json');
  if (!value || typeof value !== 'object' || !('discord_id' in value) || typeof value.discord_id !== 'string') {
    return null;
  }
  return getDiscordAccount(env, value.discord_id);
}

/** Contents of a `.auralicense` file: the key on its own line so it's also human-readable. */
export function licenseFileContents(key: string): string {
  return `${key}\n`;
}

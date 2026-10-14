import { describe, expect, it } from 'vitest';
import readme from '../../README.md?raw';
import packageJson from '../package.json?raw';
import wrangler from '../wrangler.toml?raw';
import script from '../scripts/register-discord-commands.mjs?raw';
import commands from '../src/discord_commands.json';

describe('Discord bot deployment setup', () => {
  it('registers commands and schedules expired-role reconciliation', () => {
    expect(packageJson).toContain('register:discord');
    expect(wrangler).toContain('[triggers]');
    expect(wrangler).toContain('crons = ["0 * * * *"]');
    expect(script).toContain('discord_commands.json');
    expect(commands.map((c) => c.name)).toEqual(expect.arrayContaining(['upgrade', 'credits', 'license']));
  });

  it('documents the interactions endpoint, app callback, and bot bindings', () => {
    expect(readme).toContain('https://api.copal.run/v1/discord/interactions');
    expect(readme).toContain('https://api.copal.run/v1/auth/discord/callback');
    expect(readme).toContain('DISCORD_PUBLIC_KEY');
    expect(readme).toContain('DISCORD_STAFF_ROLE_ID');
    expect(readme).toContain('DISCORD_TRIAL_CHANNEL_ID');
  });
});

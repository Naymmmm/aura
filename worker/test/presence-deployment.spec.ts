import { describe, expect, it } from 'vitest';
import source from '../../presence/src/index.mjs?raw';
import packageJson from '../../presence/package.json?raw';
import compose from '../../presence/compose.yml?raw';

describe('Aura gateway presence deployment', () => {
  it('ships an always-on Docker service with a minimal Guilds-only Discord client', () => {
    expect(source).toContain('GatewayIntentBits.Guilds');
    expect(source).toContain('setPresence');
    expect(source).toContain('Aura VPN');
    expect(packageJson).toContain('discord.js');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose).toContain('DISCORD_BOT_TOKEN');
  });
});

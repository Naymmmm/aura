import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          API_SECRET: 'test-api-secret',
          ADMIN_PASSWORD: 'test-admin-password',
          DISCORD_CLIENT_ID: 'discord-client-id',
          DISCORD_CLIENT_SECRET: 'discord-client-secret',
          DISCORD_GUILD_ID: 'discord-guild-id',
          DISCORD_REQUIRED_ROLE_ID: '1544233739322789948',
          DISCORD_PUBLIC_KEY: 'test-public-key',
          DISCORD_BOT_TOKEN: 'test-bot-token',
          DISCORD_STAFF_ROLE_ID: '800000000000000001',
          DISCORD_LOG_CHANNEL_ID: '700000000000000099',
          DISCORD_TRIAL_CHANNEL_ID: '700000000000000001',
          DISCORD_RELEASE_CHANNEL_ID: 'discord-release-channel-id',
          DOWNLOAD_SESSION_SECRET: 'test-download-session-secret',
          RELEASE_UPLOAD_TOKEN: 'test-release-upload-token',
        },
      },
    }),
  ],
});

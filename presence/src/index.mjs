import { ActivityType, Client, GatewayIntentBits } from 'discord.js';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('DISCORD_BOT_TOKEN is required');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', (readyClient) => {
  readyClient.user.setPresence({
    status: 'online',
    activities: [{ name: 'Aura VPN', type: ActivityType.Watching }],
  });
  console.log(`Aura presence online as ${readyClient.user.tag}`);
});

client.on('error', (error) => console.error('Discord client error', error));
client.on('shardError', (error) => console.error('Discord gateway error', error));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    client.destroy();
    process.exit(0);
  });
}

await client.login(token);

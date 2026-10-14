// Shared with the Worker's admin "Register commands" button.
import commands from '../src/discord_commands.json' with { type: 'json' };

const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !guildId || !botToken) {
  throw new Error('Set DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, and DISCORD_BOT_TOKEN');
}

const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
  {
    method: 'PUT',
    headers: { authorization: `Bot ${botToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  }
);
if (!response.ok) throw new Error(`Discord command registration failed (${response.status}): ${await response.text()}`);
const registered = await response.json();
console.log(`Registered ${registered.length} Aura commands in guild ${guildId}`);

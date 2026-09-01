const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !guildId || !botToken) {
  throw new Error('Set DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, and DISCORD_BOT_TOKEN');
}

const user = { name: 'user', description: 'Discord member', type: 6, required: true };
const commands = [
  {
    name: 'trial-panel',
    description: 'Post the Aura free-trial claim panel in this channel',
    default_member_permissions: '0',
  },
  {
    name: 'upgrade',
    description: 'Upgrade an Aura member to Standard for 30 days',
    default_member_permissions: '0',
    options: [user],
  },
  {
    name: 'credits',
    description: 'Convert an AUD payment into Standard Aura days',
    default_member_permissions: '0',
    options: [user, { name: 'aud', description: 'AUD received (minimum A$2)', type: 10, min_value: 2, max_value: 10000, required: true }],
  },
  {
    name: 'days',
    description: 'Add or remove Aura access days',
    default_member_permissions: '0',
    options: [
      { name: 'action', description: 'Whether to add or remove days', type: 3, required: true, choices: [{ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }] },
      user,
      { name: 'amount', description: 'Number of days', type: 4, min_value: 1, max_value: 3650, required: true },
    ],
  },
  {
    name: 'budget',
    description: 'Add data budget to an Aura member',
    default_member_permissions: '0',
    options: [user, { name: 'amount', description: 'GB to add', type: 10, min_value: 0.1, max_value: 10000, required: true }],
  },
  {
    name: 'trial-replenish',
    description: 'Give a free-trial member another seven days',
    default_member_permissions: '0',
    options: [user],
  },
  {
    name: 'account',
    description: 'Show an Aura member account',
    default_member_permissions: '0',
    options: [user],
  },
  {
    name: 'logs',
    description: 'Show recent Aura account changes for a member',
    default_member_permissions: '0',
    options: [user],
  },
];

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

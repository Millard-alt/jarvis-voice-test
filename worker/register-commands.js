// register-commands.js
// Run once: node register-commands.js (with .env filled)
// Requires DISCORD_TOKEN (bot token) and DISCORD_APP_ID and GUILD_ID.

require('dotenv').config?.();
const fs = require('node:fs');
const path = require('node:path');
// minimal .env loader
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.DISCORD_APP_ID;
const GUILD_ID = process.env.GUILD_ID || '1337703819991056504';

if (!TOKEN || !APP_ID) {
  console.error('Set DISCORD_TOKEN and DISCORD_APP_ID in .env');
  process.exit(1);
}

const commands = [
  {
    name: 'task',
    description: 'Start a coding task',
    options: [{ name: 'prompt', description: 'What to do', type: 3, required: true }],
  },
  {
    name: 'model',
    description: 'Choose the model',
    options: [{ name: 'name', description: 'Model name', type: 3, required: true }],
  },
  {
    name: 'status',
    description: 'Show last task status',
  },
  {
    name: 'stop',
    description: 'Cancel the running task',
  },
  {
    name: 'call',
    description: 'Start a voice call',
  },
];

(async () => {
  // Guild commands (instant in the server)
  const guildUrl = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`;
  const r1 = await fetch(guildUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  console.log('guild:', r1.status, await r1.text());

  // Global commands (available in DMs; may take up to 1 hour to propagate)
  const globalUrl = `https://discord.com/api/v10/applications/${APP_ID}/commands`;
  const r2 = await fetch(globalUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  console.log('global:', r2.status, await r2.text());
  if (!r1.ok && !r2.ok) process.exit(1);
})();

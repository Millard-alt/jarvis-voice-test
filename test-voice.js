// test-voice.js
// Joins your #call voice channel, DMs you a link, and plays a beep when you join.
const PROCESS_START_MS = Date.now();
console.log('PROCESS_START', new Date(PROCESS_START_MS).toISOString());
// Implements hang-up rules from the spec:
//   - owner leaves the call (after a short grace period)
//   - owner says they are done  (voice phrase: handled in a later step)
//   - job stopped/cancelled     (SIGTERM/SIGINT)
//   - owner never joins         (~3 minutes)
//   - hard maximum call length
//   - bot kicked / moved / channel deleted
// Token comes from the DISCORD_TOKEN environment variable. Never paste it into code.

const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport,
} = require('@discordjs/voice');
const { Readable } = require('node:stream');

// Minimal .env loader (no dependency). Does not override existing env vars.
try {
  const fs = require('node:fs');
  const path = require('node:path');
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch (e) {
  // ignore
}

const TOKEN = process.env.DISCORD_TOKEN;
const USER_ID = process.env.USER_ID || '1270343449643843736';
const GUILD_ID = process.env.GUILD_ID || '1337703819991056504';
const CHANNEL_ID = process.env.CHANNEL_ID || '1337703819991056508';

const GRACE_MS = Number(process.env.GRACE_MS || 5000);
const JOIN_TIMEOUT_MS = Number(process.env.JOIN_TIMEOUT_MS || 3 * 60 * 1000);
const MAX_CALL_MS = Number(process.env.MAX_CALL_MS || 10 * 60 * 1000);
const STAY_MS = Number(process.env.STAY_MS || 0); // 0 = use MAX_CALL_MS

if (!TOKEN) {
  console.error('Set DISCORD_TOKEN first.');
  process.exit(1);
}

console.log(generateDependencyReport());

// 48 kHz, 16-bit, stereo raw PCM sine wave (so no FFmpeg is needed for the test)
function beep(seconds = 3, hz = 440) {
  const rate = 48000;
  const total = rate * seconds;
  const frames = 960; // 20 ms per chunk
  let i = 0;
  return new Readable({
    read() {
      if (i >= total) return this.push(null);
      const buf = Buffer.alloc(frames * 4);
      for (let f = 0; f < frames; f++) {
        const v = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000);
        buf.writeInt16LE(v, f * 4);
        buf.writeInt16LE(v, f * 4 + 2);
        i++;
      }
      this.push(buf);
    },
  });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let connection = null;
let player = null;
let guildRef = null;
let cleaned = false;
let ownerHasJoined = false;
let graceTimer = null;
let joinTimer = null;
let maxTimer = null;

function clearTimers() {
  if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
  if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
  if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
}

async function leave(reason, code = 0) {
  if (cleaned) return;
  cleaned = true;
  clearTimers();
  console.log(`Leaving: ${reason}`);
  try {
    if (connection) {
      try { connection.disconnect(); } catch (e) { console.error('disconnect error:', e); }
      // Give Discord time to receive the leave payload before tearing down.
      await new Promise((r) => setTimeout(r, 1000));
      try { connection.destroy(); } catch (e) { console.error('destroy error:', e); }
    }
    // Backup: tell Discord via REST that the bot left the voice channel.
    if (guildRef && guildRef.members && guildRef.members.me) {
      try {
        await Promise.race([
          guildRef.members.me.voice.disconnect().catch(() => {}),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch (e) { console.error('rest disconnect error:', e); }
    }
  } catch (e) {
    console.error('connection cleanup error:', e);
  }
  try { await client.destroy(); } catch (e) { console.error('client destroy error:', e); }
  await new Promise((r) => setTimeout(r, 500));
  process.exit(code);
}

function fail(err) {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  leave('failure', 1);
}

// Signal handling: GitHub Actions cancellation / Ctrl+C -> clean leave.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    console.log(`Received ${sig}.`);
    leave(`signal ${sig}`, 0);
  });
}
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  fail(err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
  fail(err);
});

let started = false;
async function start() {
  if (started) return;
  started = true;
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  guildRef = guild;
  const channel = await guild.channels.fetch(CHANNEL_ID);

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });
  connection.on('stateChange', (o, n) => {
    console.log(`voice: ${o.status} -> ${n.status}`);
    if (n.status === VoiceConnectionStatus.Destroyed) {
      // Already destroyed; make sure we exit.
      if (!cleaned) leave('connection destroyed', 0);
    }
    if (n.status === VoiceConnectionStatus.Disconnected) {
      // Could be kicked/moved/channel deleted. Try a short reconnect window; if it
      // stays disconnected, leave.
      setTimeout(() => {
        if (connection && connection.state.status === VoiceConnectionStatus.Disconnected) {
          leave('disconnected (kicked/moved/channel deleted?)', 1);
        }
      }, 2000);
    }
  });
  connection.on('error', (err) => {
    console.error('connection error:', err);
    fail(err);
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  const readyElapsed = ((Date.now() - PROCESS_START_MS) / 1000).toFixed(1);
  console.log('Voice connection READY');
  console.log('READY', new Date().toISOString());
  console.log(`IN_PROCESS_ELAPSED_S=${readyElapsed}`);

  player = createAudioPlayer();
  connection.subscribe(player);

  const user = await client.users.fetch(USER_ID);
  await user.send(
    `I'm waiting in the call channel. Tap to join: https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`
  );
  console.log('DM sent');

  // Hard maximum call length.
  const maxMs = STAY_MS > 0 ? STAY_MS : MAX_CALL_MS;
  maxTimer = setTimeout(() => {
    console.log('Max call length reached. Leaving.');
    leave('max call length', 0);
  }, maxMs);

  // Owner never joins within ~3 minutes.
  joinTimer = setTimeout(() => {
    if (!ownerHasJoined) {
      console.log('Owner never joined. Leaving.');
      leave('join timeout', 0);
    }
  }, JOIN_TIMEOUT_MS);

  // Channel deleted while we are in it.
  client.on('channelDelete', (ch) => {
    if (ch && ch.id === CHANNEL_ID) {
      console.log('Channel deleted. Leaving.');
      leave('channel deleted', 0);
    }
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    // Bot itself: kicked / moved / left.
    if (newState.id === client.user.id) {
      const wasInChannel = oldState.channelId === CHANNEL_ID;
      const nowInChannel = newState.channelId === CHANNEL_ID;
      if (wasInChannel && !nowInChannel) {
        console.log('Bot was kicked or moved. Leaving.');
        leave('bot kicked/moved', 0);
      }
      return;
    }
    if (newState.id !== USER_ID) return;

    const wasIn = oldState.channelId === CHANNEL_ID;
    const isIn = newState.channelId === CHANNEL_ID;

    if (!wasIn && isIn) {
      // Joined.
      ownerHasJoined = true;
      if (joinTimer) { clearTimeout(joinTimer); joinTimer = null; }
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      console.log('You joined. Playing a beep.');
      player.play(createAudioResource(beep(3), { inputType: StreamType.Raw }));
    } else if (wasIn && !isIn) {
      // Left. Grace period before leaving, so a reconnect works.
      console.log('You left. Starting grace period.');
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        if (!cleaned) {
          console.log('Grace period expired. Leaving.');
          leave('owner left', 0);
        }
      }, GRACE_MS);
    }
  });
}

// discord.js renamed "ready" to "clientReady" in newer versions, so listen for both.
client.once('clientReady', () => start().catch(fail));
client.once('ready', () => start().catch(fail));

client.login(TOKEN).catch(fail);

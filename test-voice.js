// test-voice.js
// Joins your #call voice channel, DMs you a link, and plays a beep when you join.
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

const TOKEN = process.env.DISCORD_TOKEN;
const USER_ID = '1270343449643843736';
const GUILD_ID = '1337703819991056504';
const CHANNEL_ID = '1337703819991056508';
const STAY_MS = 5 * 60 * 1000; // leave after 5 minutes

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

let started = false;
async function start() {
  if (started) return;
  started = true;
  console.log(`Logged in as ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(CHANNEL_ID);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
  });
  connection.on('stateChange', (o, n) => console.log(`voice: ${o.status} -> ${n.status}`));

  // The big question: does the voice connection reach "ready" from this machine?
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  console.log('Voice connection READY');

  const player = createAudioPlayer();
  connection.subscribe(player);

  const user = await client.users.fetch(USER_ID);
  await user.send(
    `I'm waiting in the call channel. Tap to join: https://discord.com/channels/${GUILD_ID}/${CHANNEL_ID}`
  );
  console.log('DM sent');

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.id === USER_ID && newState.channelId === CHANNEL_ID && oldState.channelId !== CHANNEL_ID) {
      console.log('You joined. Playing a beep.');
      player.play(createAudioResource(beep(3), { inputType: StreamType.Raw }));
    }
  });

  setTimeout(() => {
    console.log('Time is up. Leaving.');
    connection.destroy();
    client.destroy();
    process.exit(0);
  }, STAY_MS);
}

// discord.js renamed "ready" to "clientReady" in newer versions, so listen for both.
client.once('clientReady', () => start().catch(fail));
client.once('ready', () => start().catch(fail));

function fail(err) {
  console.error('FAILED:', err);
  process.exit(1);
}

client.login(TOKEN).catch(fail);

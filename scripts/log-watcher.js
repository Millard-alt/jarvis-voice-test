const fs = require('fs');

const token = process.env.DISCORD_TOKEN;
const channel = process.env.LOGS_CHANNEL;
const file = process.env.LOG_FILE;
const doneFile = process.env.DONE_FILE;

let offset = 0;
let buf = '';

async function post(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) { chunks.push(text.slice(i, i + 1900)); i += 1900; }
  for (const c of chunks) {
    try {
      await fetch('https://discord.com/api/v10/channels/' + channel + '/messages', {
        method: 'POST',
        headers: { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: c }),
      });
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1200));
  }
}

(async () => {
  while (true) {
    try {
      if (fs.existsSync(file)) {
        const st = fs.statSync(file);
        if (st.size > offset) {
          const fd = fs.openSync(file, 'r');
          const b = Buffer.alloc(st.size - offset);
          fs.readSync(fd, b, 0, b.length, offset);
          fs.closeSync(fd);
          offset = st.size;
          buf += b.toString('utf8');
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx + 1);
            buf = buf.slice(idx + 1);
            await post(line);
          }
        }
      }
    } catch (e) {}
    if (fs.existsSync(doneFile)) {
      if (buf.length) { await post(buf); buf = ''; }
      await post('DONE ✅');
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
})();

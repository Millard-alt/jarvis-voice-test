/**
 * Jarvis voice assistant Discord bot worker.
 *
 * Receives Discord interaction events, verifies their Ed25519 signature
 * against DISCORD_PUBLIC_KEY, and routes slash commands (task, model, status,
 * stop, call) to GitHub Actions workflow dispatches via the GitHub API.
 * Only the owner (OWNER_ID) may trigger commands.
 */
import nacl from 'tweetnacl';

const OWNER_ID = '1270343449643843736';

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

async function verifySignature(request, body, publicKey) {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;
  const message = new TextEncoder().encode(timestamp + body);
  const sig = hexToBytes(signature);
  const key = hexToBytes(publicKey);
  return nacl.sign.detached.verify(message, sig, key);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleInteraction(interaction, env) {
  if (interaction.type === 1) {
    return jsonResponse({ type: 1 });
  }

  const userId = interaction.member?.user?.id || interaction.user?.id;
  if (userId !== OWNER_ID) {
    return new Response(null, { status: 204 });
  }

  if (interaction.type !== 2) {
    return jsonResponse({ type: 4, data: { content: 'Unknown interaction' } });
  }

  const command = interaction.data.name;
  const options = interaction.data.options || [];
  const getOption = (name) => options.find((o) => o.name === name)?.value;

  if (command === 'task') {
    const prompt = getOption('prompt') || '';
    const last = await env.JARVIS_KV.get('last_task_ts');
    const now = Date.now();
    if (last && now - Number(last) < 30000) {
      return jsonResponse({ type: 4, data: { content: 'Rate limited. Wait 30s between tasks.' } });
    }
    await env.JARVIS_KV.put('last_task_ts', String(now));

    const [owner, repoName] = env.TASK_REPO.split('/');
    console.log('Dispatching workflow', env.TASK_WORKFLOW, 'in', env.TASK_REPO);
    const ghResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${env.TASK_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
        'User-Agent': 'jarvis-worker',
          'X-GitHub-Api-Version': '2026-03-10',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { task: prompt } }),
      }
    );
    if (!ghResp.ok) {
      const errText = await ghResp.text();
      console.error('GitHub dispatch failed', ghResp.status, errText);
      return jsonResponse({ type: 4, data: { content: `Failed to start task (${ghResp.status}): ${errText.slice(0, 200)}` } });
    }
    const runData = await ghResp.json().catch(() => ({}));
    if (runData.workflow_run_id) {
      await env.JARVIS_KV.put('last_task_run', String(runData.workflow_run_id));
    }
    return jsonResponse({ type: 4, data: { content: 'Task started. Working on it...' } });
  }

  if (command === 'model') {
    const name = getOption('name');
    await env.JARVIS_KV.put('model', name);
    return jsonResponse({ type: 4, data: { content: `Model set to ${name}.` } });
  }

  if (command === 'status') {
    const runId = await env.JARVIS_KV.get('last_task_run');
    if (!runId) {
      return jsonResponse({ type: 4, data: { content: 'No task run recorded.' } });
    }
    const [owner, repoName] = env.TASK_REPO.split('/');
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${runId}`,
      {
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
        'User-Agent': 'jarvis-worker',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      }
    );
    const data = await r.json();
    return jsonResponse({
      type: 4,
      data: { content: `Last task run #${runId}: ${data.status} (${data.conclusion || 'in progress'})` },
    });
  }

  if (command === 'stop') {
    const runId = await env.JARVIS_KV.get('last_task_run');
    if (!runId) {
      return jsonResponse({ type: 4, data: { content: 'No task run to stop.' } });
    }
    const [owner, repoName] = env.TASK_REPO.split('/');
    await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/actions/runs/${runId}/cancel`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
        'User-Agent': 'jarvis-worker',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      }
    );
    return jsonResponse({ type: 4, data: { content: 'Stop requested.' } });
  }

  if (command === 'call') {
    const [owner, repoName] = env.VOICE_REPO.split('/');
    const ghResp = await fetch(
      `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${env.VOICE_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
        'User-Agent': 'jarvis-worker',
          'X-GitHub-Api-Version': '2026-03-10',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: {} }),
      }
    );
    if (!ghResp.ok) {
      const errText = await ghResp.text();
      console.error('GitHub dispatch failed (call)', ghResp.status, errText);
      return jsonResponse({ type: 4, data: { content: `Failed to start call (${ghResp.status}): ${errText.slice(0, 200)}` } });
    }
    return jsonResponse({ type: 4, data: { content: 'Starting a call. I will DM you a link shortly.' } });
  }

  return jsonResponse({ type: 4, data: { content: 'Unknown command.' } });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    const body = await request.text();
    const isValid = await verifySignature(request, body, env.DISCORD_PUBLIC_KEY);
    if (!isValid) {
      return new Response('Invalid signature', { status: 401 });
    }
    const interaction = JSON.parse(body);
    return handleInteraction(interaction, env);
  },
};

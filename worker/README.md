# Jarvis Worker (Cloudflare)

Discord interactions endpoint + GitHub Actions trigger.

## Deploy

1. Install: `cd worker && npm install`
2. Login: `npx wrangler login`
3. Create KV namespace: `npx wrangler kv namespace create JARVIS_KV`
   Copy the returned id into `wrangler.toml` (`id` and `preview_id`).
4. Set secrets (each prompts for value):
   `npx wrangler secret put DISCORD_PUBLIC_KEY`
   `npx wrangler secret put GITHUB_TOKEN`
5. Set vars in `wrangler.toml` `[vars]` (or via dashboard): `TASK_REPO`, `TASK_WORKFLOW`, `VOICE_REPO`, `VOICE_WORKFLOW`.
   Example:
   ```
   [vars]
   TASK_REPO = "Millard-alt/jarvis-voice-test"
   TASK_WORKFLOW = "task-test.yml"
   VOICE_REPO = "Millard-alt/jarvis-voice-test"
   VOICE_WORKFLOW = "voice-test.yml"
   ```
6. Deploy: `npm run deploy` -> note the Worker URL.
7. In Discord Developer Portal -> your app -> General Information -> Interactions Endpoint URL: paste `https://<worker>.<subdomain>.workers.dev/`.
8. Register slash commands: fill `DISCORD_TOKEN`, `DISCORD_APP_ID`, `GUILD_ID` in root `.env`, then `cd worker && npm run register`.

## Notes

- GitHub token needs `repo` (and `workflow`) scope to trigger/cancel runs.
- Free plan: 100k req/day, 10ms CPU/req. This Worker stays well inside.
- Rate limit: /task is limited to one per 30s via KV.

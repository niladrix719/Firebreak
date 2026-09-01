# Firebreak

Slack bot for incident response. `/incident declare` opens a channel, pulls recent GitHub merges/deploys, and has an agent figure out which ones are worth looking at. `/incident resolve` drafts a postmortem from the timeline and files it as a GitHub issue. MCP server included so you can query incidents from Claude Code.

## Commands

- `/incident declare [sev1|sev2|sev3] <what's broken>`
- `/incident note <text>`
- `/incident status <investigating|identified|monitoring>`
- `/incident resolve`
- `/incident list [open|all]`
- `/incident show`

Run these from inside the incident channel, or pass a key from anywhere: `/incident note INC-2026-0007 db failover finished`.

## Setup

Needs Node 22.5+.

1. Create a Slack app: enable Socket Mode, add the `/incident` slash command, bot scopes `channels:manage channels:read chat:write commands groups:write users:read bookmarks:write`.
2. GitHub fine-grained PAT: Contents (read), Pull requests (read), Deployments (read), Issues (read + write).
3. `cp .env.example .env` and fill in the Slack values — GitHub and Anthropic are optional, the bot just runs without correlation/AI if they're missing.
4. `npm install && npm run dev`, then `/incident help` in Slack.

MCP server:

```bash
claude mcp add firebreak -e DATABASE_PATH=./data/firebreak.db -- npx tsx src/mcp/server.ts
```

## Dev

```bash
npm test
npm run typecheck
npm run lint
```

## License

MIT

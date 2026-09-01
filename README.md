# Firebreak

Incident-response bot for Slack.

`/incident declare` opens a channel, pulls whatever merged or deployed in the last 48 hours from GitHub, and runs an agent over that list to figure out which changes are actually worth looking at. `/incident resolve` turns the timeline into a postmortem and files it as a GitHub issue. There's also an MCP server so you can ask Claude Code things like "what shipped before that outage" without leaving your editor.

## Try it without any setup

```bash
npm install
npm run demo
```

This runs a full incident — declare, correlate, a few notes, resolve — against fake Slack and GitHub, and prints what would've been posted to the channel. No Slack app, no GitHub token, no API key.

```
-- /incident declare sev2 Checkout API returning 502s for roughly 15% of requests

  .-- #inc-2026-0004-checkout-api-returning-502s-for-roughly-15-of-requests
  | INC-2026-0004 — Checkout API returning 502s for roughly 15% of requests
  | Severity: SEV2          Status: investigating
  | ...

-- Correlating recent changes ------------------------------------

  .-- #inc-2026-0004-checkout-api-returning-502s-for-roughly-15-of-requests
  | Recent changes that could be related
  | [HIGH] deploy:99182 — Deploy to production (success) — main@8f2c1a4
  | [HIGH] #482 — Move checkout session storage from in-process cache to Redis
  | [MED]  #479 — Revert "Enable HTTP keep-alive between edge and checkout"
  | ...
```

That output is from the offline fallback (no `ANTHROPIC_API_KEY` set) — it ranks by keyword and recency, and it says so in the message. Run it with a real key and the agent instead does the correlation by actually reading diffs:

```bash
ANTHROPIC_API_KEY=sk-... npm run demo -- --live
```

The demo writes to `./data/demo.db`, a real SQLite file, so once it's done you can point the MCP server at it and query the incident for real (see below).

## Commands

- `/incident declare [sev1|sev2|sev3] <what's broken>` — opens a channel, posts a template, pulls recent changes, runs correlation
- `/incident note <text>` — add to the timeline
- `/incident status <investigating|identified|monitoring>`
- `/incident resolve` — draft a postmortem, file it as a GitHub issue
- `/incident list [open|all]`
- `/incident show` — dump the timeline

`note`/`status`/`resolve`/`show` work from inside the incident channel, or from anywhere if you pass a key: `/incident note INC-2026-0007 db failover finished`.

Severity defaults to sev2. `declare sev1 payments are down` and `declare payments are down --sev1` both work, and a severity-looking word inside the actual title (`declare alerting for sev3 pages is broken`) is left alone.

## Why the correlation isn't just "summarize the diff list"

Handing an LLM a list of PR titles and asking which one is suspicious mostly gets you guesses based on how the title reads, which isn't reliable — a PR called "raise checkout page copy limit" and one called "move checkout session storage to Redis" sound about equally relevant, and only one of them touches code that runs.

So instead of a summary, the model gets three tools:

- `inspect_change(id)` — pull the real diff, files touched, PR body
- `find_changes_touching(path)` — which candidates touched files under a given path
- `submit_report(...)` — how it hands back the answer; this is forced on the last turn so a run can't just trail off with nothing

It has to actually pull a diff before it's allowed to call something "high" likelihood. The demo fixture is built to test this: there's a real cause in there (a session store moved to Redis, sized at 384 connections against a cluster capped at 512) and a red herring that says "checkout" more often than the real cause does but only touches two JSON locale files. Keyword matching ranks the red herring higher. The agent, after pulling both diffs, doesn't.

A few things keep the output honest:
- The answer comes back as a tool call with a schema, not free text — nothing gets parsed out of prose.
- Findings referencing a change that isn't in the actual candidate list get dropped and logged instead of shown as a dead link.
- The prompt tells it not to assert causation, and to say plainly when nothing in the window looks suspicious rather than force-ranking noise.

The Slack message always says which model produced it and, if it fell back, why.

## MCP server

Three read-only tools — `list_incidents`, `get_timeline`, `recent_changes`. There's a `.mcp.json` already committed, so if you're in this repo directory Claude Code picks it up automatically. To register it elsewhere:

```bash
claude mcp add firebreak -e DATABASE_PATH=./data/demo.db -- npx tsx src/mcp/server.ts
```

The reason `recent_changes` takes an incident key instead of just querying GitHub live: a month later, branches get rebased and PRs get retargeted, so "what merged before Tuesday" answered live gives you a different list than what responders actually saw. Passing an incident key replays the exact snapshot captured at declare time instead.

No write path on the server, no Slack/GitHub credentials either — it can't touch an incident, only read it.

## What happens when something's down

- Slack can't open a channel → incident is still recorded, you can keep logging notes by key from wherever you are
- GitHub's unreachable → declare still works, correlation just reports zero changes instead of erroring
- No `ANTHROPIC_API_KEY`, or the API call fails (bad key, no credits, whatever) → falls back to a keyword + recency heuristic and says clearly in the message that it's degraded
- GitHub rejects opening the postmortem issue → the draft stays on the incident record instead of getting lost
- Model returns something malformed → fails closed to a plain change list, not garbage

More on this and the general architecture in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Setup

Needs Node 22.5+ (uses the built-in `node:sqlite`, no native deps to build).

### Slack

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps).
2. There's a manifest at [`slack-app-manifest.yaml`](slack-app-manifest.yaml) — pick "create from manifest" and paste it in, it sets up the slash command, scopes, and Socket Mode in one go. Or do it by hand: enable Socket Mode, generate an app-level token with `connections:write`, add bot scopes `channels:manage channels:read chat:write commands groups:write users:read bookmarks:write`, add the `/incident` slash command.
3. Install to your workspace.
4. You need three values out of this: bot token (`xoxb-...`), signing secret, and the app-level token (`xapp-...`).

### GitHub

A fine-grained personal access token with Contents (read), Pull requests (read), Deployments (read), Issues (read and write), scoped to whichever repo you want it watching.

### Run it

```bash
cp .env.example .env    # fill in the three Slack values at minimum
npm install
npm run dev
```

Then `/incident help` in Slack.

`SLACK_*` is the only required group. `GITHUB_*` and `ANTHROPIC_*` are optional — leave either one out entirely and the bot still runs, just without change correlation or with the offline fallback. Fill in half of a group, though, and it refuses to boot and tells you what's missing, since that's more likely a typo than an intentional choice.

Docker: `docker compose up --build`.

## Development

```bash
npm test           # no network, no credentials needed
npm run typecheck
npm run lint
npm run demo
npm run mcp
```

Tests cover the command parser, the SQLite store (including incident-key allocation under concurrency and timeline ordering when two notes land in the same millisecond), the degradation paths, the agent loop against a scripted Anthropic client, and the MCP tools over a real in-memory transport.

## Layout

```
src/
  core/       domain model + the incident service
  slack/      bolt app, command parsing, block kit rendering
  github/     octokit adapter
  llm/        agent loop, prompts, offline fallback
  store/      sqlite + migrations
  mcp/        the mcp server
  cli/        demo / seed scripts
  testing/    fakes and fixtures shared by the demo and the tests
  util/       retry, ids, time, logging, error types
```

## License

MIT

# Firebreak

**An agentic incident-response bot for Slack.** You type `/incident declare sev2 checkout is returning 502s`. Firebreak opens a channel, posts the response template, pulls every pull request merged and every deployment shipped in the last 48 hours from the GitHub API, and puts an agent to work on the question every responder asks first: *what did we just change?*

The agent doesn't summarise the change list. It investigates it — pulling the diff for anything that looks relevant, searching for changes that touched the failing subsystem, and returning a ranked set of suspects with its reasoning cited against what it actually read. When the incident is resolved, it drafts a blameless postmortem from the timeline responders typed plus those changes, and opens it as a GitHub issue.

Everything it records is queryable over MCP, so you can ask from your editor:

> *what shipped before the Tuesday outage?*

---

## See it work in 30 seconds

No Slack workspace, no GitHub token, no API key.

```bash
npm install
npm run demo
```

This runs a complete incident end to end against in-process fakes for Slack and GitHub, printing what would have been posted into the channel:

```
-- /incident declare sev2 Checkout API returning 502s for roughly 15% of requests

  .-- #inc-2026-0004-checkout-api-returning-502s-for-roughly-15-of-requests
  | INC-2026-0004 — Checkout API returning 502s for roughly 15% of requests
  | Severity: SEV2          Status: investigating
  | Declared by: @U0RHEE    Declared at: 2026-09-01 21:30 UTC
  | ----------------------------------------------------------------
  | Roles — claim one by posting in the channel.
  | • Incident Commander — unclaimed
  | ...

-- Correlating recent changes ------------------------------------

  .-- #inc-2026-0004-checkout-api-returning-502s-for-roughly-15-of-requests
  | Recent changes that could be related
  | Ranked 7 change(s) by term overlap with the incident title and by
  | recency. Top suspect: deploy:99182 — Deploy to production (success).
  | This is a keyword match, not an analysis; verify before acting.
  | ----------------------------------------------------------------
  | [HIGH] deploy:99182 — Deploy to production (success) — main@8f2c1a4
  |   mentions "checkout"; shipped 34m before the incident; touches 3 file(s).
  | [HIGH] #482 — Move checkout session storage from in-process cache to Redis
  |   mentions "checkout"; shipped 51m before the incident; touches 5 file(s).
  | [HIGH] #481 — Raise checkout page copy limit to 240 characters
  |   mentions "checkout"; shipped 96m before the incident; touches 2 file(s).
  | [MED]  #479 — Revert "Enable HTTP keep-alive between edge and checkout"
  |   mentions "checkout", "502s"; looks like a revert; 19.7h before.
  | ----------------------------------------------------------------
  | [warn] Degraded mode — no Anthropic API key configured; using keyword
  |        heuristics. Treat this ranking as a hint, not a finding.
```

That is the **offline fallback**, and it is showing you its own limits: `#481` is a content-only change to marketing copy that happens to say "checkout" three times, and a keyword matcher cannot tell it apart from the Redis migration that actually broke. It says so in the footer rather than pretending otherwise.

Run it with the real agent loop and that stops happening — the agent pulls the diff for `#481`, sees two JSON locale files, and drops it:

```bash
ANTHROPIC_API_KEY=sk-... npm run demo -- --live
```

The demo writes to a real SQLite database at `./data/demo.db`, so when it finishes you can query the incident for real over MCP.

---

## The commands

| Command | What happens |
|---|---|
| `/incident declare [sev1\|sev2\|sev3] <what is broken>` | Opens a channel, invites the declarer, posts the response template, pulls recent merges and deploys, runs the correlation agent, announces to the ops channel |
| `/incident note <what you observed>` | Appends to the incident timeline. This is the postmortem's source material |
| `/incident status <investigating\|identified\|monitoring>` | Updates status and records the transition on the timeline |
| `/incident resolve` | Closes the incident, drafts the postmortem, opens it as a GitHub issue, bookmarks it in the channel |
| `/incident list [open\|all]` | Recent incidents |
| `/incident show` | The timeline so far |

Run `note`, `status`, `resolve`, and `show` from inside an incident channel, or pass a key from anywhere: `/incident note INC-2026-0007 db failover finished`.

Severity defaults to `sev2` and can lead or trail: `declare sev1 payments are down` and `declare payments are down --sev1` both work. A severity word inside the title is left alone — `declare alerting for sev3 pages is broken` is a sev2 about sev3 paging.

---

## What makes the correlation agentic

The naive version of this feature stuffs the change list into a prompt and asks for a summary. That produces confident nonsense, because a one-line PR title is not enough information to judge by. "Bump pino to 9.13.1" and "Move checkout session storage to Redis" read equally plausible at declare time.

Firebreak gives the model a candidate list and two read tools, and lets it decide what it needs:

| Tool | Returns |
|---|---|
| `inspect_change` | Files touched, diff stat, PR body, and whether it looks like a revert or hotfix |
| `find_changes_touching` | Which candidates changed files under a path — `services/checkout`, `migrations/`, `nginx` |
| `submit_report` | The structured answer. The loop runs until the model calls this |

So the model reads the symptom, forms a hypothesis about which subsystem would produce it, pulls diffs for the changes that touch it, and rules the rest out. The demo fixture is built to punish the naive version: it contains a real cause (a session store moved to Redis, sized at 384 connections against a cluster capped at 512), a red herring that mentions "checkout" more often than the real cause does but only touches locale files, and five pieces of ordinary noise.

Four things keep it honest:

- **Structured output is a tool call, not parsed prose.** `submit_report` has a schema; findings that fail validation degrade to a change list rather than reaching a responder as a hallucination.
- **Findings are resolved against the real change list.** If the model returns `pr:9999`, the finding is dropped and logged rather than rendered as a dead link. ([`anthropic.ts`](src/llm/anthropic.ts))
- **The turn budget is bounded and the last turn is forced.** On the final iteration `tool_choice` is pinned to `submit_report`, so an incident channel always gets an answer instead of a loop that ran out of budget.
- **The prompt forbids asserting causation.** It ranks plausibility for humans who will verify, and is told to say so plainly when nothing in the window is a credible suspect.

The Slack message says which model produced it, how many tool calls it made, and — when it fell back — why.

---

## Query it from Claude Code

The MCP server exposes the incident record read-only over stdio. A [`.mcp.json`](.mcp.json) is committed, so after `npm run demo` Claude Code picks it up in this directory with no further setup.

To register it manually:

```bash
claude mcp add firebreak -e DATABASE_PATH=./data/demo.db -- npx tsx src/mcp/server.ts
```

| Tool | What it answers |
|---|---|
| `list_incidents` | *Which incidents did we have last week?* Filters by status, severity, date window, or title text |
| `get_timeline` | *What happened during INC-2026-0004?* Metadata, every timeline entry, the correlation from declare time, the postmortem link |
| `recent_changes` | *What shipped before the Tuesday outage?* Given an incident key, returns exactly what was captured at declare time — the historical record, unaffected by everything merged since. Given a window instead, queries GitHub live |

That distinction is the whole point of the correlation feature: a live GitHub query answers "what has merged as of right now," which quietly drifts as branches get rebased and deployments get superseded, while `recent_changes` on an incident key answers "what did the responders actually see" — a fixed, replayable snapshot from the moment the incident was declared.

The server holds no Slack or GitHub credentials of its own and has no write path, so pointing an agent at it cannot mutate an incident.

---

## Architecture

```
      Slack (Socket Mode)                     Claude Code / any MCP client
              │                                            │
              ▼                                            ▼
      ┌───────────────┐                            ┌───────────────┐
      │  slack/app    │  parses /incident          │  mcp/server   │  read-only
      │  parseCommand │  → ParsedCommand           │  mcp/tools    │  stdio
      └───────┬───────┘                            └───────┬───────┘
              │                                            │
              ▼                                            │
      ┌─────────────────────────────────────────┐          │
      │        core/incidentService             │          │
      │  declare · investigate · note · resolve │          │
      └───┬─────────┬──────────┬────────────────┘          │
          │         │          │                           │
     ChatPort   GitHubPort  LlmPort              IncidentStore
          │         │          │                           │
          ▼         ▼          ▼                           ▼
   SlackChat   GitHubClient  AnthropicLlm         SqliteIncidentStore
    Adapter    (Octokit)     (agent loop)          (node:sqlite)
        │           │            │
     FakeChat   FakeGitHub   HeuristicLlm      ← the same interfaces, in tests
                             (offline fallback)   and in `npm run demo`
```

`core/` holds the domain and knows nothing about Slack, GitHub, Anthropic, or SQLite — it depends only on the four interfaces in [`core/ports.ts`](src/core/ports.ts). Every production adapter is constructed in one place, [`composition.ts`](src/composition.ts). That is what lets the entire service run end to end with no credentials, which is not a test-only convenience: it is also how the thing degrades when a dependency is down at 3am.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the reasoning behind the boundaries and the failure model.

---

## Degradation, deliberately

An incident tool that fails during an incident is worse than no tool. Every dependency has a defined behaviour when it is unavailable:

| What breaks | What still works |
|---|---|
| **Slack channel creation fails** | The incident is still recorded and addressable by key. `/incident note INC-2026-0007 …` keeps working from anywhere |
| **GitHub is unreachable** | The incident, channel, template, and timeline are unaffected. The correlation reports zero changes rather than failing the command |
| **`ANTHROPIC_API_KEY` is unset, or the API is down** | A deterministic fallback ranks changes on term overlap, exponential recency decay, and revert markers, and labels itself degraded in the channel. Postmortems become a structured transcription of the timeline with `TODO` where analysis would go |
| **GitHub rejects the postmortem issue** | The draft is stored on the incident and the channel says where to find it, instead of the draft being lost |
| **The model returns a malformed report** | Validation fails closed to the change list rather than rendering garbage |
| **Slack's 3-second command deadline** | `declare` acknowledges immediately and posts the investigation into the channel when it lands, rather than timing out |

The fallback engine is [`llm/heuristic.ts`](src/llm/heuristic.ts). It is not clever and its own output says so.

---

## Setup

### Requirements

Node **22.5+** (for the built-in `node:sqlite` — there are no native dependencies to compile).

### Slack app

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) → **From scratch**.
2. **Socket Mode** → enable. Generate an app-level token with `connections:write` → that's `SLACK_APP_TOKEN`.
3. **OAuth & Permissions** → bot token scopes: `channels:manage`, `channels:read`, `chat:write`, `commands`, `groups:write`, `users:read`, `bookmarks:write`.
4. **Slash Commands** → create `/incident`. With Socket Mode the request URL is ignored.
5. Install to the workspace. Copy the bot token (`xoxb-…`) and signing secret.

### GitHub token

A fine-grained PAT scoped to the repo you deploy, with **Contents: read**, **Pull requests: read**, **Deployments: read**, **Issues: read and write**.

### Run it

```bash
cp .env.example .env    # fill in
npm install
npm run dev             # or: npm run build && npm start
```

Then in Slack: `/incident help`.

Only the `SLACK_*` variables are required. `GITHUB_*` and `ANTHROPIC_*` are optional groups — configure all of a group or none of it. A half-configured group fails at boot with the missing variable named, because that is a typo rather than an intent.

### Docker

```bash
docker compose up --build
```

The incident record lives on the `firebreak-data` volume.

---

## Development

```bash
npm test           # 160 tests, no network
npm run typecheck
npm run lint
npm run demo       # full incident, offline
npm run seed       # historical incidents only, for populating a database
npm run mcp        # MCP server on stdio
```

The suite covers the command grammar, the store (including key allocation under concurrency and timeline ordering when timestamps collide), the service's degradation paths, the agent loop against a scripted Anthropic client, the MCP tools over a real in-memory transport, and configuration validation. It needs no credentials and makes no network calls.

## Project layout

```
src/
  core/            domain model, ports, and the incident service
  slack/           Bolt app, command parser, Block Kit rendering, chat adapter
  github/          Octokit adapter, and a null adapter for when it is unconfigured
  llm/             agent loop, prompts, tool schemas, offline fallback
  store/           SQLite store and forward-only migrations
  mcp/             read-only MCP server
  cli/             offline demo and seed harnesses
  testing/         fakes and fixtures, shared by the demo and the tests
  util/            retry, ids, time, structured logging, error taxonomy
```

## License

MIT

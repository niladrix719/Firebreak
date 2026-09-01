# Architecture

Notes on why Firebreak is shaped the way it is. The [README](../README.md) covers what it does.

---

## The constraint that drives everything

An incident tool is used at the worst moment its users will have that quarter. Two things follow.

**It must not add a failure mode.** If Firebreak throws because GitHub rate-limited it, the responder has lost thirty seconds they did not have, and now has two problems. Every dependency therefore has a defined degraded behaviour rather than an exception path, and no optional integration can prevent the core loop — declare, log, resolve — from working.

**Its output has to be legible in five seconds.** A responder scanning a channel does not read a paragraph. This is why the correlation output is a ranked list with a likelihood badge and one sentence of grounding per finding, why the badges are sorted so scanning down them is monotonic, and why the message footer always states which engine produced it.

---

## Ports and adapters

[`core/`](../src/core) contains the domain model, the service, and four interfaces. It imports no vendor SDK.

```ts
interface GitHubPort   { listRecentChanges, getChangeDetail, createIssue, repoSlug }
interface ChatPort     { createChannel, invite, post, setBookmark? }
interface LlmPort      { correlate, draftPostmortem, model }
interface IncidentStore { ...persistence }
```

Adapters live in `slack/`, `github/`, `llm/`, and `store/`. Every `new` for a production adapter happens in [`composition.ts`](../src/composition.ts) and nowhere else.

The payoff is not "testability" in the abstract. It is three concrete things:

1. **`npm run demo` runs the real service.** Not a mock of it — the actual `IncidentService`, the actual SQLite store, the actual Block Kit rendering, with fakes only at the two network boundaries. A reviewer who has never seen this repo sees the real behaviour in one command.
2. **The degraded paths are the same code paths.** `NullGitHub` and `HeuristicLlm` are adapters, not `if` branches scattered through the service. When GitHub is unconfigured, the service does not know or care.
3. **The tests assert on behaviour, not on mock call counts.** `FakeChat` records what was posted, so a test can assert that the resolution message told the responder where the draft went when GitHub rejected the issue.

---

## Why the slow half of `declare` is a returned function

Slack kills a slash command interaction after three seconds. Pulling merges and deployments from GitHub and then running a multi-turn agent loop takes considerably longer than that.

`declare()` therefore does the fast half — allocate the key, create the record, open the channel, post the template, announce — and returns:

```ts
interface DeclareResult {
  incident: Incident;
  channel: ChatChannel | null;
  investigate: () => Promise<CorrelationReport>;
}
```

The Slack handler acknowledges, responds, and calls `investigate()` without awaiting; the result posts into the channel a few seconds later. The demo and the tests *do* await it, so the slow path is exercised deterministically rather than raced.

The alternative — firing the work inside `declare()` — would make the function untestable without timers and would swallow the error. Returning it makes the asynchrony explicit at the one call site that needs to be asynchronous.

---

## What gets persisted, and why changes are snapshotted

```
incidents          one row per incident; unique index on channel_id
timeline_entries   append-only; ordered by (at, rowid)
incident_changes   the change list captured at declare time, as JSON
correlations       the agent's report, as JSON
incident_counters  per-year sequence for INC-YYYY-NNNN
```

`incident_changes` is a **snapshot**, not a query. Asking GitHub a month later what merged before Tuesday 14:00 gives a different answer than the one responders had: branches get rebased, PRs get retargeted, deployments get superseded. The postmortem needs the list that was actually on screen. This is also why the MCP `recent_changes` tool takes an incident key as its primary mode and only falls back to a live query when given a bare window.

Changes and correlation reports are stored as JSON rather than normalised into columns. They are read as whole documents, never filtered on, and their shape is owned by `core/types.ts` — three good reasons not to spread them across five tables.

### Two ordering decisions

**Timeline entries order by `(at, rowid)`, not `(at, id)`.** During an incident several notes land in the same millisecond. Ids carry a random suffix, so ordering by id shuffles same-millisecond entries — which in practice meant a postmortem showing "status changed to monitoring" before the note explaining why. `rowid` is insertion order, which is the only correct tiebreak. There is a test for exactly this.

**Incident keys are allocated in a `BEGIN IMMEDIATE` transaction.** Two people typing `/incident declare` at the same moment is not hypothetical during a large outage. The counter is incremented and read inside one write transaction; a test allocates 25 concurrently and asserts they are all distinct.

---

## The agent loop

[`llm/anthropic.ts`](../src/llm/anthropic.ts). The loop is deliberately small — roughly forty lines — because the interesting decisions are at its edges.

```
messages = [candidate change list + incident symptom]
repeat up to maxTurns:
    response = create(tools, tool_choice = auto | forced on the last turn)
    append the assistant message
    if submit_report was called  -> validate, resolve ids, return
    if no tool was called        -> nudge once, continue
    otherwise                    -> run each tool, append tool_result blocks
```

**Structured output is a tool.** Anthropic's tool schema does the shape enforcement, and `submit_report` is validated again with Zod on the way in. Nothing parses free text.

**Diffs are fetched lazily and cached per run.** `find_changes_touching` needs the diff for every candidate, so without a cache a single call would re-fetch what `inspect_change` already pulled. The cache lives for one correlation run and is keyed by change id.

**The last turn is forced.** `tool_choice: { type: 'tool', name: 'submit_report' }` on the final iteration. An incident channel getting a report grounded in three of seven diffs is strictly better than getting nothing because the model wanted a fourth.

**Findings are resolved against the real change list.** A finding naming an id that isn't in the candidate set is dropped and logged. This is not defensive programming for its own sake: a rendered link to `pr:9999` during an outage sends someone to a 404 while the page is on fire.

**Failure is a report, not an exception.** A malformed report or a validation failure produces a `CorrelationReport` with `degraded` set, which renders as a warning footer above the raw change list. Responders get the changes either way.

---

## Prompt design

Both prompts are in [`llm/prompts.ts`](../src/llm/prompts.ts), and the choices in them are the same kind of engineering as the code.

**The correlation prompt tells the model to start from the symptom, not the list.** Left to itself a model walks the change list top to bottom and rationalises each entry. Reasoning from "what kind of change would produce this symptom" toward the list is what makes `find_changes_touching` useful rather than decorative.

**It is told not to be ruled by recency.** Recency is a strong signal and a lazy one. The prompt names the specific case where it misleads: a config change behind a slow rollout that shipped hours earlier.

**"High" requires having inspected something.** Without that, the model rates on titles, and titles are exactly what is not trustworthy here.

**The postmortem prompt bans invention explicitly** and gives it somewhere to go instead: "Not captured in the timeline." A postmortem that quietly invents an impact figure is worse than one with a gap, because the gap is visible in review and the invention is not.

Both prompts state that an LLM wrote the draft, and the GitHub issue body repeats it in a footer. Nobody should have to guess whether a human wrote the root cause section.

---

## Error taxonomy

[`util/errors.ts`](../src/util/errors.ts). One axis matters: is this safe to show a Slack user verbatim?

- `UsageError`, `ConflictError`, `NotFoundError` — user-facing. They carry the correction ("Use `/incident resolve` so the postmortem gets drafted").
- `UpstreamError` — not user-facing. It carries which service failed and the original as `cause`, and reaches the user as a generic message while the detail goes to the log.

The Slack handler renders `messageFor(err)`, which respects that flag. This is why a GitHub token expiry never appears in a public incident channel.

---

## Retries

[`util/retry.ts`](../src/util/retry.ts). Exponential backoff with **full jitter** — the delay is uniform in `[0, ceiling]` rather than `ceiling`. During a real outage several responders run commands at once against an API that is also struggling; synchronised retries make that worse.

Only 408, 429, 5xx, and transport errors retry. A 4xx is a bug or a permissions problem and will not heal in 250ms.

`mapWithConcurrency` bounds the deployment-status fan-out at five. Listing 100 deployments and fetching each one's status unbounded is how you get rate-limited at the exact moment you need the API.

---

## Testing approach

160 tests, no network, no credentials, sub-second.

- **The store** is tested against real SQLite (`:memory:`), not a mock. Migrations, the unique channel index, concurrent key allocation, and same-millisecond timeline ordering are all properties of the actual engine.
- **The agent loop** is tested against a scripted Anthropic client that replays a fixed sequence of responses. This makes multi-turn behaviour — tool results being fed back, the nudge on a prose answer, the forced final turn, id caching — assertable without a network call.
- **The MCP server** is tested over `InMemoryTransport` with a real `Client` on the other end, so the schemas, annotations, and error shapes are the ones a client actually sees.
- **The service** is tested through its public surface with fakes at the boundaries, including every degraded path: channel creation failing, GitHub unreachable, issue creation rejected, double resolution.

What is deliberately not tested: the Octokit and Bolt adapters. They are thin translation layers over vendor SDKs, and a test of them would mostly assert that the mock was called — which is the kind of test that breaks on refactors and catches nothing.

---

## Things a production deployment would need

Stated plainly rather than pretended away.

- **SQLite is single-node.** Correct for one bot process, which is the deployment this targets. Multiple replicas need Postgres; the `IncidentStore` interface is the seam, and the SQL is nearly portable already.
- **No authorization model.** Anyone in the workspace can declare and resolve. Real teams want resolution restricted to responders, and an audit trail of who did what — the timeline already records the actor, so this is a policy check, not a schema change.
- **One repository.** `GITHUB_OWNER`/`GITHUB_REPO` are single values. A team with a service mesh wants a set, which mostly means fanning `listRecentChanges` out across repos and tagging each change with its origin.
- **No paging integration.** Declaring an incident should be able to page the on-call. That is a fifth port.
- **Costs are unbounded per incident.** The turn budget caps tool calls, but nothing caps declarations. A rate limit per user per hour belongs in the Slack handler.

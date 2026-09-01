import { describe, expect, it, vi } from 'vitest';
import { IncidentService, channelNameFor } from '../src/core/incidentService.js';
import type { CorrelateInput, LlmPort } from '../src/core/ports.js';
import type { CorrelationReport, IncidentSnapshot, Postmortem } from '../src/core/types.js';
import { SqliteIncidentStore } from '../src/store/sqliteStore.js';
import { FakeChat, FakeGitHub } from '../src/testing/fakes.js';
import { storefrontChanges } from '../src/testing/fixtures.js';
import { ConflictError, NotFoundError } from '../src/util/errors.js';

class StubLlm implements LlmPort {
  readonly model = 'stub';
  correlateCalls: CorrelateInput[] = [];
  postmortemCalls: IncidentSnapshot[] = [];

  async correlate(input: CorrelateInput): Promise<CorrelationReport> {
    this.correlateCalls.push(input);
    return {
      summary: `looked at ${input.changes.length} change(s)`,
      findings: input.changes.slice(0, 1).map((c) => ({
        changeId: c.id,
        ref: `#${c.prNumber ?? 0}`,
        title: c.title,
        url: c.url,
        likelihood: 'high' as const,
        reasoning: 'stub',
      })),
      suggestedChecks: ['check the thing'],
      toolCalls: 2,
      model: this.model,
    };
  }

  async draftPostmortem(snapshot: IncidentSnapshot): Promise<Postmortem> {
    this.postmortemCalls.push(snapshot);
    return {
      title: `${snapshot.incident.key}: ${snapshot.incident.title}`,
      markdown: `# ${snapshot.incident.key}\n\n${snapshot.timeline.length} timeline entries`,
      labels: ['postmortem'],
    };
  }
}

const ACTOR = { id: 'U0RHEE', name: 'rhee' };
const DECLARED_AT = new Date('2026-09-01T14:00:00.000Z');

function setup(options: { announceChannel?: string } = {}) {
  const store = new SqliteIncidentStore(':memory:');
  const chat = new FakeChat();
  const github = new FakeGitHub(storefrontChanges(DECLARED_AT));
  const llm = new StubLlm();

  // A clock that advances a minute per read, so timeline order is meaningful.
  let cursor = DECLARED_AT.getTime();
  const clock = () => new Date((cursor += 60_000) - 60_000);

  const service = new IncidentService(
    { store, chat, github, llm },
    { lookbackHours: 48, lookbackLimit: 30, clock, ...options },
  );
  return { store, chat, github, llm, service };
}

describe('IncidentService.declare', () => {
  it('creates an incident, a channel, and a first timeline entry', async () => {
    const { service, chat, store } = setup();

    const { incident, channel } = await service.declare({
      title: 'Checkout API returning 502s',
      severity: 'sev2',
      actor: ACTOR,
    });

    expect(incident.key).toBe('INC-2026-0001');
    expect(incident.status).toBe('investigating');
    expect(incident.declaredAt).toBe('2026-09-01T14:00:00.000Z');
    expect(channel?.name).toBe('inc-2026-0001-checkout-api-returning-502s');
    expect(incident.channelId).toBe(channel!.id);

    const timeline = await store.getTimeline(incident.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ kind: 'declared', authorName: 'rhee' });

    expect(chat.invites).toEqual([{ channelId: channel!.id, userIds: ['U0RHEE'] }]);
    expect(chat.postsFor(channel!.id)).toHaveLength(1);
  });

  it('posts the response template into the new channel', async () => {
    const { service, chat } = setup();
    const { channel } = await service.declare({ title: 'Search is slow', severity: 'sev3', actor: ACTOR });

    const blocks = JSON.stringify(chat.postsFor(channel!.id)[0]!.blocks);
    expect(blocks).toContain('Incident Commander');
    expect(blocks).toContain('First five minutes');
    expect(blocks).toContain('SEV3');
  });

  it('announces to the announcement channel but not into the incident channel', async () => {
    const { service, chat } = setup({ announceChannel: 'C_ANNOUNCE' });
    const { channel } = await service.declare({ title: 'Payments down', severity: 'sev1', actor: ACTOR });

    const announcements = chat.postsFor('C_ANNOUNCE');
    expect(announcements).toHaveLength(1);
    expect(announcements[0]!.text).toContain('INC-2026-0001');
    expect(announcements[0]!.text).toContain(`<#${channel!.id}>`);
  });

  it('keeps the incident when Slack refuses to open a channel', async () => {
    const { service, chat, store } = setup();
    chat.failCreate = true;

    const { incident, channel } = await service.declare({ title: 'Everything is down', severity: 'sev1', actor: ACTOR });

    expect(channel).toBeNull();
    expect(incident.channelId).toBeNull();
    // The record still exists and is still addressable by key.
    expect(await store.getIncident('INC-2026-0001')).not.toBeNull();
    expect(await store.getTimeline(incident.id)).toHaveLength(1);
  });

  it('numbers incidents sequentially', async () => {
    const { service } = setup();
    const first = await service.declare({ title: 'One', severity: 'sev3', actor: ACTOR });
    const second = await service.declare({ title: 'Two', severity: 'sev3', actor: ACTOR });
    expect([first.incident.key, second.incident.key]).toEqual(['INC-2026-0001', 'INC-2026-0002']);
  });
});

describe('IncidentService.investigate', () => {
  it('stores the changes and the correlation, and posts the summary', async () => {
    const { service, chat, store, llm } = setup();
    const { incident, channel, investigate } = await service.declare({
      title: 'Checkout API returning 502s',
      severity: 'sev2',
      actor: ACTOR,
    });

    const report = await investigate();

    expect(llm.correlateCalls).toHaveLength(1);
    expect(llm.correlateCalls[0]!.changes.length).toBeGreaterThan(0);
    expect(await store.getChanges(incident.id)).toHaveLength(report.findings.length > 0 ? 7 : 7);
    expect(await store.getCorrelation(incident.id)).toMatchObject({ summary: report.summary });
    expect((await store.getIncident(incident.id))!.correlationSummary).toBe(report.summary);

    const posts = chat.postsFor(channel!.id);
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts[1]!.blocks)).toContain('Recent changes that could be related');
  });

  it('only considers changes that shipped before the incident was declared', async () => {
    const { service, llm } = setup();
    const { investigate } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });
    await investigate();

    const changes = llm.correlateCalls[0]!.changes;
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      expect(new Date(change.at).getTime()).toBeLessThanOrEqual(DECLARED_AT.getTime());
    }
  });

  it('still produces a report when GitHub is unreachable', async () => {
    const { service, github, store } = setup();
    const { incident, investigate } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });
    github.failing = true;

    const report = await investigate();

    expect(report.summary).toContain('0 change');
    expect(await store.getChanges(incident.id)).toEqual([]);
  });

  it('gives the correlator a way to fetch diffs on demand', async () => {
    const { service, llm, github } = setup();
    const { investigate } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });
    await investigate();

    const detail = await llm.correlateCalls[0]!.fetchDetail('pr:482');
    expect(detail?.filesChanged).toContain('services/checkout/session.ts');
    expect(github.detailRequests).toContain('pr:482');
  });
});

describe('IncidentService.addNote', () => {
  it('appends to the timeline of the channel it was run in', async () => {
    const { service, store } = setup();
    const { incident, channel } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });

    await service.addNote({ ref: { channelId: channel!.id }, text: 'redis is at maxclients', actor: ACTOR });

    const timeline = await store.getTimeline(incident.id);
    expect(timeline.map((e) => e.text)).toEqual(['Declared SEV2: Checkout 502s', 'redis is at maxclients']);
  });

  it('accepts an explicit key from outside the channel', async () => {
    const { service, store } = setup();
    const { incident } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });

    await service.addNote({ ref: { key: 'INC-2026-0001', channelId: 'C_RANDOM' }, text: 'from elsewhere', actor: ACTOR });

    expect((await store.getTimeline(incident.id)).at(-1)!.text).toBe('from elsewhere');
  });

  it('rejects a note in a channel that is not an incident channel', async () => {
    const { service } = setup();
    await expect(
      service.addNote({ ref: { channelId: 'C_RANDOM' }, text: 'hello', actor: ACTOR }),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects a note on a resolved incident', async () => {
    const { service } = setup();
    const { channel } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });
    await service.resolve({ ref: { channelId: channel!.id }, actor: ACTOR });

    await expect(
      service.addNote({ ref: { channelId: channel!.id }, text: 'late note', actor: ACTOR }),
    ).rejects.toThrow(ConflictError);
  });
});

describe('IncidentService.setStatus', () => {
  it('records the transition on the timeline', async () => {
    const { service, store } = setup();
    const { incident, channel } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });

    const updated = await service.setStatus({ ref: { channelId: channel!.id }, status: 'identified', actor: ACTOR });

    expect(updated.status).toBe('identified');
    expect((await store.getTimeline(incident.id)).at(-1)).toMatchObject({
      kind: 'status',
      text: 'Status changed from investigating to identified',
    });
  });

  it('is a no-op when the status is unchanged', async () => {
    const { service, store } = setup();
    const { incident, channel } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });

    await service.setStatus({ ref: { channelId: channel!.id }, status: 'investigating', actor: ACTOR });

    expect(await store.getTimeline(incident.id)).toHaveLength(1);
  });

  it('refuses to resolve through setStatus', async () => {
    const { service } = setup();
    const { channel } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });
    await expect(
      service.setStatus({ ref: { channelId: channel!.id }, status: 'resolved', actor: ACTOR }),
    ).rejects.toThrow(/incident resolve/);
  });
});

describe('IncidentService.resolve', () => {
  it('drafts a postmortem from the timeline and opens it as an issue', async () => {
    const { service, github, llm, chat, store } = setup();
    const { incident, channel, investigate } = await service.declare({
      title: 'Checkout API returning 502s',
      severity: 'sev2',
      actor: ACTOR,
    });
    await investigate();
    await service.addNote({ ref: { channelId: channel!.id }, text: 'redis maxclients reached', actor: ACTOR });

    const result = await service.resolve({ ref: { channelId: channel!.id }, actor: ACTOR });

    expect(result.incident.status).toBe('resolved');
    expect(result.incident.resolvedAt).not.toBeNull();
    expect(result.issue).toMatchObject({ url: expect.stringContaining('/issues/') });

    // The draft is built from the record, including the changes and correlation.
    const snapshot = llm.postmortemCalls[0]!;
    expect(snapshot.timeline.map((e) => e.text)).toContain('redis maxclients reached');
    expect(snapshot.changes).toHaveLength(7);
    expect(snapshot.correlation).not.toBeNull();

    expect(github.issues[0]!.labels).toContain('postmortem');
    expect(github.issues[0]!.body).toContain(result.postmortem.markdown.trimEnd());
    // The issue body must say a machine wrote it.
    expect(github.issues[0]!.body).toMatch(/Drafted by \[Firebreak\]/);

    expect((await store.getIncident(incident.id))!.postmortemMarkdown).toBe(result.postmortem.markdown);
    expect(chat.bookmarks).toEqual([{ channelId: channel!.id, title: 'Postmortem', url: result.issue!.url }]);
  });

  it('keeps the draft when GitHub rejects the issue', async () => {
    const { service, github, store, chat } = setup();
    const { incident, channel } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });
    github.failing = true;

    const result = await service.resolve({ ref: { channelId: channel!.id }, actor: ACTOR });

    expect(result.issue).toBeNull();
    expect(result.postmortem.markdown).toContain('INC-2026-0001');
    expect((await store.getIncident(incident.id))!.postmortemMarkdown).toContain('INC-2026-0001');
    expect((await store.getIncident(incident.id))!.status).toBe('resolved');
    expect(JSON.stringify(chat.postsFor(channel!.id).at(-1)!.blocks)).toContain('could not be opened');
  });

  it('refuses to resolve twice', async () => {
    const { service } = setup();
    const { channel } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });
    await service.resolve({ ref: { channelId: channel!.id }, actor: ACTOR });

    await expect(service.resolve({ ref: { channelId: channel!.id }, actor: ACTOR })).rejects.toThrow(ConflictError);
  });

  it('closes the timeline with a resolved entry', async () => {
    const { service, store } = setup();
    const { incident, channel } = await service.declare({ title: 'Checkout 502s', severity: 'sev2', actor: ACTOR });
    await service.resolve({ ref: { channelId: channel!.id }, actor: ACTOR });

    expect((await store.getTimeline(incident.id)).at(-1)).toMatchObject({ kind: 'resolved' });
  });
});

describe('IncidentService.snapshot', () => {
  it('gathers the incident, timeline, changes, and correlation', async () => {
    const { service } = setup();
    const { incident, channel, investigate } = await service.declare({
      title: 'Checkout 502s',
      severity: 'sev2',
      actor: ACTOR,
    });
    await investigate();
    await service.addNote({ ref: { channelId: channel!.id }, text: 'a note', actor: ACTOR });

    const snapshot = await service.snapshot(incident.key);

    expect(snapshot.incident.key).toBe('INC-2026-0001');
    expect(snapshot.timeline).toHaveLength(2);
    expect(snapshot.changes).toHaveLength(7);
    expect(snapshot.correlation?.model).toBe('stub');
  });

  it('reports a missing incident clearly', async () => {
    const { service } = setup();
    await expect(service.snapshot('INC-1999-0001')).rejects.toThrow(/No incident matching/);
  });
});

describe('channelNameFor', () => {
  it('builds a Slack-legal channel name', () => {
    expect(channelNameFor('INC-2026-0007', 'Checkout API returning 502s!')).toBe(
      'inc-2026-0007-checkout-api-returning-502s',
    );
  });

  it('stays within Slack\'s 80-character limit', () => {
    const name = channelNameFor('INC-2026-0007', 'a'.repeat(200));
    expect(name.length).toBeLessThanOrEqual(80);
  });

  it('does not leave a trailing hyphen or half a word', () => {
    const name = channelNameFor('INC-2026-0007', 'the quick brown fox jumps over the lazy dog and keeps running onward');
    expect(name).not.toMatch(/-$/);
    expect(name.length).toBeLessThanOrEqual(80);
  });

  it('survives a title with no usable characters', () => {
    expect(channelNameFor('INC-2026-0007', '???')).toBe('inc-2026-0007-incident');
  });
});

describe('clock injection', () => {
  it('uses the wall clock by default', async () => {
    const store = new SqliteIncidentStore(':memory:');
    const service = new IncidentService(
      { store, chat: new FakeChat(), github: new FakeGitHub([]), llm: new StubLlm() },
      { lookbackHours: 1, lookbackLimit: 1 },
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-02T03:04:05.000Z'));
    const { incident } = await service.declare({ title: 'x', severity: 'sev3', actor: ACTOR });
    expect(incident.declaredAt).toBe('2030-01-02T03:04:05.000Z');
    vi.useRealTimers();
    store.close();
  });
});

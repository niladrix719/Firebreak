import type { ChatChannel, ChatPort, GitHubPort, IncidentStore, LlmPort } from './ports.js';
import type {
  Actor,
  ChangeEvent,
  CorrelationReport,
  Incident,
  IncidentSnapshot,
  IncidentStatus,
  Postmortem,
  Severity,
  TimelineEntry,
  TimelineKind,
} from './types.js';
import { ConflictError, NotFoundError, UpstreamError } from '../util/errors.js';
import { newId, slugify } from '../util/ids.js';
import { hoursAgo } from '../util/time.js';
import { logger } from '../util/logger.js';
import { incidentChannelBlocks, correlationBlocks, resolutionBlocks } from '../slack/blocks.js';

export interface IncidentServiceOptions {
  lookbackHours: number;
  lookbackLimit: number;
  announceChannel?: string | undefined;
  /** Injected so tests can freeze time. */
  clock?: () => Date;
}

export interface DeclareResult {
  incident: Incident;
  channel: ChatChannel | null;
  /**
   * The slow half of declaring: GitHub + the correlation agent. Kept separate
   * so the Slack handler can acknowledge within Slack's 3-second budget and
   * let the investigation land in the channel a few seconds later.
   */
  investigate: () => Promise<CorrelationReport>;
}

export interface ResolveResult {
  incident: Incident;
  postmortem: Postmortem;
  issue: { number: number; url: string } | null;
}

export class IncidentService {
  private readonly clock: () => Date;

  constructor(
    private readonly deps: {
      store: IncidentStore;
      github: GitHubPort;
      chat: ChatPort;
      llm: LlmPort;
    },
    private readonly options: IncidentServiceOptions,
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  // --- declare ------------------------------------------------------------

  async declare(input: { title: string; severity: Severity; actor: Actor }): Promise<DeclareResult> {
    const now = this.clock();
    const key = await this.deps.store.nextIncidentKey(now);

    const incident: Incident = {
      id: newId('inc', now),
      key,
      title: input.title,
      severity: input.severity,
      status: 'investigating',
      declaredBy: input.actor.id,
      declaredByName: input.actor.name,
      declaredAt: now.toISOString(),
      resolvedAt: null,
      channelId: null,
      channelName: null,
      correlationSummary: null,
      postmortemUrl: null,
      postmortemMarkdown: null,
    };

    await this.deps.store.createIncident(incident);

    // A failure to open the channel must not lose the incident record — the
    // responder can still add notes by key and resolve it later.
    let channel: ChatChannel | null = null;
    const channelName = channelNameFor(key, input.title);
    try {
      channel = await this.deps.chat.createChannel(
        channelName,
        `${key} (${input.severity.toUpperCase()}) — ${input.title}`,
      );
      await this.deps.chat.invite(channel.id, [input.actor.id]);
    } catch (err) {
      logger.error({ err, key, channelName }, 'could not open the incident channel');
    }

    const withChannel = await this.deps.store.updateIncident(incident.id, {
      channelId: channel?.id ?? null,
      channelName: channel?.name ?? null,
    });

    await this.append(withChannel, {
      kind: 'declared',
      actor: input.actor,
      text: `Declared ${input.severity.toUpperCase()}: ${input.title}`,
    });

    if (channel) {
      await this.deps.chat.post(channel.id, `${key} declared`, incidentChannelBlocks(withChannel));
      await this.announce(withChannel);
    }

    return {
      incident: withChannel,
      channel,
      investigate: () => this.investigate(withChannel),
    };
  }

  /** Pull recent changes, run the correlation agent, post the result. */
  async investigate(incident: Incident): Promise<CorrelationReport> {
    const changes = await this.collectChanges(incident);
    await this.deps.store.saveChanges(incident.id, changes);

    const report = await this.deps.llm.correlate({
      incident: {
        key: incident.key,
        title: incident.title,
        severity: incident.severity,
        declaredAt: incident.declaredAt,
      },
      changes,
      fetchDetail: (changeId) => this.deps.github.getChangeDetail(changeId),
    });

    await this.deps.store.saveCorrelation(incident.id, report);
    await this.deps.store.updateIncident(incident.id, { correlationSummary: report.summary });

    if (incident.channelId) {
      await this.deps.chat
        .post(
          incident.channelId,
          `Recent changes that could be related to ${incident.key}`,
          correlationBlocks(report, changes, this.deps.github.repoSlug()),
        )
        .catch((err) => logger.error({ err, key: incident.key }, 'could not post the correlation summary'));
    }

    logger.info(
      { key: incident.key, changes: changes.length, findings: report.findings.length, toolCalls: report.toolCalls },
      'correlation complete',
    );
    return report;
  }

  private async collectChanges(incident: Incident): Promise<ChangeEvent[]> {
    try {
      return await this.deps.github.listRecentChanges({
        since: hoursAgo(this.options.lookbackHours, new Date(incident.declaredAt)),
        until: new Date(incident.declaredAt),
        limit: this.options.lookbackLimit,
      });
    } catch (err) {
      logger.error({ err, key: incident.key }, 'could not list recent changes');
      return [];
    }
  }

  private async announce(incident: Incident): Promise<void> {
    const target = this.options.announceChannel;
    if (!target || target === incident.channelId) return;
    const link = incident.channelId ? `<#${incident.channelId}>` : '(no channel)';
    await this.deps.chat
      .post(target, `:rotating_light: *${incident.key}* (${incident.severity.toUpperCase()}) — ${incident.title} → ${link}`)
      .catch((err) => logger.warn({ err }, 'could not post to the announcement channel'));
  }

  // --- notes and status ---------------------------------------------------

  async addNote(input: { ref: IncidentRef; text: string; actor: Actor }): Promise<TimelineEntry> {
    const incident = await this.resolveRef(input.ref);
    if (incident.status === 'resolved') {
      throw new ConflictError(`${incident.key} is already resolved. Reopen it before adding notes.`);
    }
    return this.append(incident, { kind: 'note', actor: input.actor, text: input.text });
  }

  async setStatus(input: { ref: IncidentRef; status: IncidentStatus; actor: Actor }): Promise<Incident> {
    const incident = await this.resolveRef(input.ref);
    if (incident.status === input.status) return incident;
    if (input.status === 'resolved') {
      throw new ConflictError('Use `/incident resolve` so the postmortem gets drafted.');
    }

    const updated = await this.deps.store.updateIncident(incident.id, { status: input.status });
    await this.append(updated, {
      kind: 'status',
      actor: input.actor,
      text: `Status changed from ${incident.status} to ${input.status}`,
    });
    return updated;
  }

  // --- resolve ------------------------------------------------------------

  async resolve(input: { ref: IncidentRef; actor: Actor }): Promise<ResolveResult> {
    const incident = await this.resolveRef(input.ref);
    if (incident.status === 'resolved') {
      throw new ConflictError(`${incident.key} was already resolved${incident.postmortemUrl ? ` — ${incident.postmortemUrl}` : ''}.`);
    }

    const resolvedAt = this.clock().toISOString();
    const resolved = await this.deps.store.updateIncident(incident.id, { status: 'resolved', resolvedAt });
    await this.append(resolved, { kind: 'resolved', actor: input.actor, text: 'Incident resolved' });

    const snapshot = await this.snapshot(resolved.id);
    const postmortem = await this.deps.llm.draftPostmortem(snapshot);

    let issue: { number: number; url: string } | null = null;
    try {
      issue = await this.deps.github.createIssue({
        title: postmortem.title,
        body: withFooter(postmortem.markdown, resolved, this.deps.llm.model),
        labels: postmortem.labels,
      });
    } catch (err) {
      // The draft is worth keeping even when GitHub rejects the issue.
      logger.error({ err, key: resolved.key }, 'could not open the postmortem issue');
      if (!(err instanceof UpstreamError)) throw err;
    }

    const final = await this.deps.store.updateIncident(resolved.id, {
      postmortemUrl: issue?.url ?? null,
      postmortemMarkdown: postmortem.markdown,
    });

    if (final.channelId) {
      await this.deps.chat
        .post(final.channelId, `${final.key} resolved`, resolutionBlocks(final, snapshot, issue))
        .catch((err) => logger.error({ err }, 'could not post the resolution summary'));
      if (issue && this.deps.chat.setBookmark) {
        await this.deps.chat.setBookmark(final.channelId, 'Postmortem', issue.url).catch(() => {});
      }
    }

    return { incident: final, postmortem, issue };
  }

  // --- reads --------------------------------------------------------------

  async list(filter: { status?: IncidentStatus; limit?: number } = {}): Promise<Incident[]> {
    return this.deps.store.listIncidents({ status: filter.status, limit: filter.limit ?? 20 });
  }

  async snapshot(idOrKey: string): Promise<IncidentSnapshot> {
    const incident = await this.deps.store.getIncident(idOrKey);
    if (!incident) throw new NotFoundError(`No incident matching "${idOrKey}".`);
    const [timeline, changes, correlation] = await Promise.all([
      this.deps.store.getTimeline(incident.id),
      this.deps.store.getChanges(incident.id),
      this.deps.store.getCorrelation(incident.id),
    ]);
    return { incident, timeline, changes, correlation };
  }

  // --- internals ----------------------------------------------------------

  private async append(
    incident: Incident,
    entry: { kind: TimelineKind; actor: Actor; text: string },
  ): Promise<TimelineEntry> {
    const now = this.clock();
    return this.deps.store.appendTimeline({
      id: newId('tl', now),
      incidentId: incident.id,
      at: now.toISOString(),
      kind: entry.kind,
      authorId: entry.actor.id,
      authorName: entry.actor.name,
      text: entry.text,
    });
  }

  /** Resolves `{ channelId }` or `{ key }` to an incident, preferring an explicit key. */
  private async resolveRef(ref: IncidentRef): Promise<Incident> {
    if (ref.key) {
      const byKey = await this.deps.store.getIncident(ref.key);
      if (!byKey) throw new NotFoundError(`No incident matching "${ref.key}".`);
      return byKey;
    }
    if (ref.channelId) {
      const byChannel = await this.deps.store.getIncidentByChannel(ref.channelId);
      if (!byChannel) {
        throw new NotFoundError(
          'This channel is not an incident channel. Run the command from an incident channel, or pass a key like `INC-2026-0007`.',
        );
      }
      return byChannel;
    }
    throw new NotFoundError('Specify an incident key, or run this from an incident channel.');
  }
}

export interface IncidentRef {
  key?: string | undefined;
  channelId?: string | undefined;
}

/** Slack channel names: lowercase, <= 80 chars, no dots or spaces. */
export function channelNameFor(key: string, title: string): string {
  const prefix = key.toLowerCase();
  const slug = slugify(title, 80 - prefix.length - 1);
  return `${prefix}-${slug}`.slice(0, 80);
}

function withFooter(markdown: string, incident: Incident, model: string): string {
  return [
    markdown.trimEnd(),
    '',
    '---',
    `<sub>Drafted by [Firebreak](https://github.com/firebreak/firebreak) from the \`${incident.key}\` Slack timeline using \`${model}\`. Review before publishing — an LLM wrote the first pass, not the on-call.</sub>`,
  ].join('\n');
}

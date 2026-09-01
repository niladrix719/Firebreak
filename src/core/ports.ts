import type {
  ChangeDetail,
  ChangeEvent,
  CorrelationReport,
  Incident,
  IncidentSnapshot,
  IncidentStatus,
  Postmortem,
  TimelineEntry,
} from './types.js';

/**
 * Outbound ports. Each has exactly one production adapter and one test fake,
 * which is what lets the whole service run end-to-end with no credentials.
 */

export interface ChangeWindow {
  since: Date;
  until?: Date;
  limit: number;
}

export interface GitHubPort {
  /** Merged PRs and deployments inside the window, newest first. */
  listRecentChanges(window: ChangeWindow): Promise<ChangeEvent[]>;
  /** Diff stat + body for one change. Called on demand by the correlation agent. */
  getChangeDetail(changeId: string): Promise<ChangeDetail | null>;
  createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
  repoSlug(): string;
}

export interface ChatChannel {
  id: string;
  name: string;
}

export interface ChatPort {
  createChannel(name: string, topic: string): Promise<ChatChannel>;
  invite(channelId: string, userIds: string[]): Promise<void>;
  post(channelId: string, text: string, blocks?: unknown[]): Promise<{ ts: string }>;
  setBookmark?(channelId: string, title: string, url: string): Promise<void>;
}

export interface LlmPort {
  /** Runs the agentic correlation loop. */
  correlate(input: CorrelateInput): Promise<CorrelationReport>;
  /** One-shot generation for the postmortem narrative. */
  draftPostmortem(snapshot: IncidentSnapshot): Promise<Postmortem>;
  readonly model: string;
}

export interface CorrelateInput {
  incident: Pick<Incident, 'key' | 'title' | 'severity' | 'declaredAt'>;
  changes: ChangeEvent[];
  /** Lets the agent pull the diff for a change it wants to inspect. */
  fetchDetail(changeId: string): Promise<ChangeDetail | null>;
}

export interface IncidentStore {
  createIncident(incident: Incident): Promise<Incident>;
  updateIncident(id: string, patch: Partial<Incident>): Promise<Incident>;
  getIncident(idOrKey: string): Promise<Incident | null>;
  getIncidentByChannel(channelId: string): Promise<Incident | null>;
  listIncidents(filter: { status?: IncidentStatus; limit: number }): Promise<Incident[]>;
  nextIncidentKey(now: Date): Promise<string>;

  appendTimeline(entry: TimelineEntry): Promise<TimelineEntry>;
  getTimeline(incidentId: string): Promise<TimelineEntry[]>;

  saveChanges(incidentId: string, changes: ChangeEvent[]): Promise<void>;
  getChanges(incidentId: string): Promise<ChangeEvent[]>;

  saveCorrelation(incidentId: string, report: CorrelationReport): Promise<void>;
  getCorrelation(incidentId: string): Promise<CorrelationReport | null>;

  close(): void;
}

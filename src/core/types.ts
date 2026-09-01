/**
 * The Firebreak domain model.
 *
 * Everything here is plain data. Adapters (Slack, GitHub, Anthropic, SQLite)
 * translate into and out of these shapes; the core services never see a
 * vendor SDK type.
 */

export const SEVERITIES = ['sev1', 'sev2', 'sev3'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;
export type IncidentStatus = (typeof STATUSES)[number];

export interface Incident {
  id: string;
  /** Human-readable key shown in Slack and GitHub, e.g. `INC-2026-0007`. */
  key: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  declaredBy: string;
  declaredByName: string;
  declaredAt: string;
  resolvedAt: string | null;
  channelId: string | null;
  channelName: string | null;
  /** LLM correlation summary produced at declare time. */
  correlationSummary: string | null;
  postmortemUrl: string | null;
  postmortemMarkdown: string | null;
}

export const TIMELINE_KINDS = ['declared', 'note', 'status', 'system', 'resolved'] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineEntry {
  id: string;
  incidentId: string;
  at: string;
  kind: TimelineKind;
  authorId: string;
  authorName: string;
  text: string;
}

/** A merged PR or a deployment — the two things that "shipped before the outage". */
export interface ChangeEvent {
  /** Stable identity: `pr:482`, `deploy:99182`, or `commit:<sha>`. */
  id: string;
  kind: 'merge' | 'deploy';
  title: string;
  url: string;
  author: string;
  /** Merge time or deployment creation time, ISO 8601. */
  at: string;
  sha: string | null;
  prNumber: number | null;
  environment: string | null;
  /** Populated lazily by the correlator when it decides a change is worth a look. */
  detail?: ChangeDetail;
}

export interface ChangeDetail {
  body: string | null;
  filesChanged: string[];
  additions: number;
  deletions: number;
  /** True when the PR body or title mentions a rollback / revert. */
  isRevert: boolean;
}

export type Likelihood = 'high' | 'medium' | 'low';

export interface CorrelationFinding {
  changeId: string;
  ref: string;
  title: string;
  url: string;
  likelihood: Likelihood;
  reasoning: string;
}

/** What the correlation agent produces when an incident is declared. */
export interface CorrelationReport {
  summary: string;
  findings: CorrelationFinding[];
  suggestedChecks: string[];
  /** How many tool calls the agent made — surfaced so the run is auditable. */
  toolCalls: number;
  model: string;
  /** Set when the agent could not run (no API key, upstream failure). */
  degraded?: string;
}

export interface Postmortem {
  title: string;
  markdown: string;
  labels: string[];
}

export interface IncidentSnapshot {
  incident: Incident;
  timeline: TimelineEntry[];
  changes: ChangeEvent[];
  correlation: CorrelationReport | null;
}

export interface Actor {
  id: string;
  name: string;
}

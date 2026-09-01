import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z as zod } from 'zod';
import type { GitHubPort, IncidentStore } from '../core/ports.js';
import type { ChangeEvent, Incident, IncidentStatus } from '../core/types.js';
import { STATUSES } from '../core/types.js';
import { formatDuration, formatStamp } from '../util/time.js';
import { hoursAgo } from '../util/time.js';

export interface McpDeps {
  store: IncidentStore;
  github: GitHubPort;
  z: typeof zod;
}

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

export function registerIncidentTools(server: McpServer, deps: McpDeps): void {
  const { store, github, z } = deps;

  server.registerTool(
    'list_incidents',
    {
      title: 'List incidents',
      description:
        'List declared incidents, newest first. Filter by status, severity, a date window, or a substring of the title. Start here when you need to find an incident by when it happened ("the Tuesday outage").',
      inputSchema: {
        status: z.enum(STATUSES).optional().describe('Only incidents in this status.'),
        severity: z.enum(['sev1', 'sev2', 'sev3']).optional().describe('Only incidents at this severity.'),
        since: z.string().optional().describe('ISO 8601 date or datetime. Only incidents declared at or after this.'),
        until: z.string().optional().describe('ISO 8601 date or datetime. Only incidents declared at or before this.'),
        query: z.string().optional().describe('Case-insensitive substring match against the incident title.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum incidents to return. Default 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const candidates = await store.listIncidents({
        status: args.status as IncidentStatus | undefined,
        limit: 500,
      });

      const since = parseDate(args.since);
      const until = parseDate(args.until, 'end-of-day');
      const needle = args.query?.toLowerCase();

      const matches = candidates
        .filter((i) => (args.severity ? i.severity === args.severity : true))
        .filter((i) => (since ? new Date(i.declaredAt) >= since : true))
        .filter((i) => (until ? new Date(i.declaredAt) <= until : true))
        .filter((i) => (needle ? i.title.toLowerCase().includes(needle) : true))
        .slice(0, args.limit ?? 20);

      if (matches.length === 0) {
        return text(`No incidents matched. ${candidates.length} incident(s) on record in total.`);
      }

      return text(
        [`${matches.length} incident(s):`, '', ...matches.map(renderIncidentLine)].join('\n'),
      );
    },
  );

  server.registerTool(
    'get_timeline',
    {
      title: 'Get incident timeline',
      description:
        'The full record for one incident: metadata, every timeline entry responders typed during it, the correlation analysis from declare time, and the postmortem link if one was opened.',
      inputSchema: {
        incident: z.string().describe('Incident key (e.g. "INC-2026-0007") or internal id.'),
        include_changes: z
          .boolean()
          .optional()
          .describe('Also list the merges and deploys captured at declare time. Default false — use recent_changes for detail.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      const incident = await store.getIncident(args.incident);
      if (!incident) {
        return text(`No incident matching "${args.incident}". Use list_incidents to find the right key.`);
      }

      const [timeline, correlation, changes] = await Promise.all([
        store.getTimeline(incident.id),
        store.getCorrelation(incident.id),
        args.include_changes ? store.getChanges(incident.id) : Promise.resolve([]),
      ]);

      const lines = [
        `# ${incident.key} — ${incident.title}`,
        '',
        `- Severity: ${incident.severity.toUpperCase()}`,
        `- Status: ${incident.status}`,
        `- Declared: ${formatStamp(incident.declaredAt)} by ${incident.declaredByName}`,
        incident.resolvedAt
          ? `- Resolved: ${formatStamp(incident.resolvedAt)} (duration ${formatDuration(incident.declaredAt, incident.resolvedAt)})`
          : '- Resolved: still open',
        incident.channelName ? `- Slack channel: #${incident.channelName}` : '',
        incident.postmortemUrl ? `- Postmortem: ${incident.postmortemUrl}` : '',
        '',
        '## Timeline',
        '',
        ...(timeline.length
          ? timeline.map((e) => `- ${formatStamp(e.at)} [${e.kind}] ${e.authorName}: ${e.text}`)
          : ['- (no entries recorded)']),
      ];

      if (correlation) {
        lines.push('', '## Correlation at declare time', '', correlation.summary);
        if (correlation.findings.length > 0) {
          lines.push('');
          for (const f of correlation.findings) {
            lines.push(`- [${f.likelihood}] ${f.ref} — ${f.title}`, `  ${f.reasoning}`, `  ${f.url}`);
          }
        }
        lines.push(
          '',
          correlation.degraded
            ? `_Produced in degraded mode: ${correlation.degraded}._`
            : `_Produced by ${correlation.model} using ${correlation.toolCalls} tool call(s)._`,
        );
      }

      if (args.include_changes && changes.length > 0) {
        lines.push('', '## Changes captured at declare time', '', ...changes.map(renderChangeLine));
      }

      return text(lines.filter((l) => l !== '').length > 0 ? lines.join('\n') : 'Empty incident.');
    },
  );

  server.registerTool(
    'recent_changes',
    {
      title: 'Recent changes',
      description:
        'What shipped — merged pull requests and deployments. Given an incident key, returns exactly the changes captured when that incident was declared (the historical record, unaffected by later merges). Given a time window instead, queries GitHub live.',
      inputSchema: {
        incident: z
          .string()
          .optional()
          .describe('Incident key. Returns the changes recorded at that incident\'s declare time.'),
        hours: z
          .number()
          .positive()
          .max(720)
          .optional()
          .describe('Look back this many hours from now. Ignored when `incident` is set. Default 48.'),
        since: z.string().optional().describe('ISO 8601 start of a live query window. Ignored when `incident` is set.'),
        until: z.string().optional().describe('ISO 8601 end of a live query window.'),
        limit: z.number().int().min(1).max(200).optional().describe('Maximum changes to return. Default 50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const limit = args.limit ?? 50;

      if (args.incident) {
        const incident = await store.getIncident(args.incident);
        if (!incident) {
          return text(`No incident matching "${args.incident}". Use list_incidents to find the right key.`);
        }
        const changes = await store.getChanges(incident.id);
        if (changes.length === 0) {
          return text(
            `No changes were recorded for ${incident.key}. Either nothing shipped in the lookback window, or GitHub was unreachable when it was declared.`,
          );
        }
        return text(
          [
            `${changes.length} change(s) captured when ${incident.key} was declared (${formatStamp(incident.declaredAt)}), newest first:`,
            '',
            ...changes.slice(0, limit).map(renderChangeLine),
          ].join('\n'),
        );
      }

      const until = parseDate(args.until, 'end-of-day') ?? new Date();
      const since = parseDate(args.since) ?? hoursAgo(args.hours ?? 48, until);

      const changes = await github.listRecentChanges({ since, until, limit });
      if (changes.length === 0) {
        return text(
          `Nothing merged or deployed to ${github.repoSlug()} between ${formatStamp(since.toISOString())} and ${formatStamp(until.toISOString())}.`,
        );
      }
      return text(
        [
          `${changes.length} change(s) in ${github.repoSlug()} between ${formatStamp(since.toISOString())} and ${formatStamp(until.toISOString())}:`,
          '',
          ...changes.map(renderChangeLine),
        ].join('\n'),
      );
    },
  );
}

function renderIncidentLine(incident: Incident): string {
  const resolved = incident.resolvedAt
    ? `resolved after ${formatDuration(incident.declaredAt, incident.resolvedAt)}`
    : 'still open';
  return [
    `- **${incident.key}** (${incident.severity.toUpperCase()}, ${incident.status}) — ${incident.title}`,
    `  declared ${formatStamp(incident.declaredAt)} by ${incident.declaredByName}; ${resolved}`,
    incident.postmortemUrl ? `  postmortem: ${incident.postmortemUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderChangeLine(change: ChangeEvent): string {
  const env = change.environment ? ` env=${change.environment}` : '';
  return `- ${formatStamp(change.at)} [${change.kind}]${env} ${change.title} — ${change.author}\n  ${change.url}`;
}

/**
 * Accepts a bare date ("2026-09-01") or a full timestamp. A bare date used as
 * an upper bound means the end of that day, so `until: "2026-09-01"` includes
 * everything that happened on the 1st.
 */
function parseDate(value: string | undefined, mode: 'start' | 'end-of-day' = 'start'): Date | undefined {
  if (!value) return undefined;
  const isBareDate = /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const iso = isBareDate ? `${value.trim()}T${mode === 'end-of-day' ? '23:59:59.999' : '00:00:00.000'}Z` : value;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

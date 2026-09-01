import type {
  ChangeEvent,
  CorrelationReport,
  Incident,
  IncidentSnapshot,
  Likelihood,
} from '../core/types.js';
import { formatDuration, formatStamp } from '../util/time.js';

/** Block Kit is untyped here on purpose — the port takes `unknown[]`. */
type Block = Record<string, unknown>;

const SEVERITY_EMOJI: Record<string, string> = { sev1: ':red_circle:', sev2: ':large_orange_circle:', sev3: ':large_yellow_circle:' };
const LIKELIHOOD_EMOJI: Record<Likelihood, string> = { high: ':red_circle:', medium: ':large_orange_circle:', low: ':white_circle:' };

const section = (text: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text: string): Block => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const divider = (): Block => ({ type: 'divider' });

/** The template posted into a fresh incident channel. */
export function incidentChannelBlocks(incident: Incident): Block[] {
  const emoji = SEVERITY_EMOJI[incident.severity] ?? ':warning:';
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${incident.key} — ${truncate(incident.title, 130)}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity*\n${emoji} ${incident.severity.toUpperCase()}` },
        { type: 'mrkdwn', text: `*Status*\n${incident.status}` },
        { type: 'mrkdwn', text: `*Declared by*\n<@${incident.declaredBy}>` },
        { type: 'mrkdwn', text: `*Declared at*\n${formatStamp(incident.declaredAt)}` },
      ],
    },
    divider(),
    section(
      [
        '*Roles* — claim one by posting in the channel.',
        '• *Incident Commander* — _unclaimed_',
        '• *Comms* — _unclaimed_',
        '• *Ops* — _unclaimed_',
      ].join('\n'),
    ),
    section(
      [
        '*First five minutes*',
        '1. State the user-visible impact in one line.',
        '2. `/incident note <what you just observed>` — every note lands in the postmortem.',
        '3. Check the recent-changes summary posted below.',
        '4. Mitigate before you diagnose. Revert is a valid mitigation.',
      ].join('\n'),
    ),
    context('`/incident note …` to log · `/incident status identified` to update · `/incident resolve` to close and draft the postmortem'),
    context(':hourglass_flowing_sand: Pulling recent merges and deploys…'),
  ];
}

/** The correlation agent's answer, rendered for responders under pressure. */
export function correlationBlocks(
  report: CorrelationReport,
  changes: ChangeEvent[],
  repoSlug: string,
): Block[] {
  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: 'Recent changes that could be related', emoji: true } },
    section(report.summary),
  ];

  if (report.findings.length > 0) {
    blocks.push(divider());
    for (const finding of report.findings.slice(0, 5)) {
      blocks.push(
        section(
          `${LIKELIHOOD_EMOJI[finding.likelihood]} *<${finding.url}|${escape(finding.ref)}>* — ${escape(truncate(finding.title, 140))}\n_${escape(finding.reasoning)}_`,
        ),
      );
    }
  } else if (changes.length > 0) {
    blocks.push(section('_No change in the window stood out. Full list below._'));
  }

  if (report.suggestedChecks.length > 0) {
    blocks.push(divider());
    blocks.push(section(`*Suggested next checks*\n${report.suggestedChecks.map((c) => `• ${escape(c)}`).join('\n')}`));
  }

  blocks.push(divider());
  blocks.push(
    section(
      changes.length > 0
        ? `*All ${changes.length} change(s) in the window* — \`${repoSlug}\`\n${changes
            .slice(0, 12)
            .map((c) => `• ${formatStamp(c.at)} <${c.url}|${escape(truncate(c.title, 90))}> _(${c.author})_`)
            .join('\n')}${changes.length > 12 ? `\n• …and ${changes.length - 12} more` : ''}`
        : `_Nothing merged or deployed to \`${repoSlug}\` in the lookback window._`,
    ),
  );

  blocks.push(
    context(
      report.degraded
        ? `:warning: Degraded mode — ${escape(report.degraded)}. Treat this ranking as a hint, not a finding.`
        : `:robot_face: ${report.model} · ${report.toolCalls} tool call(s) · plausibility only — verify before acting`,
    ),
  );

  return blocks;
}

/** Posted when an incident is resolved. */
export function resolutionBlocks(
  incident: Incident,
  snapshot: IncidentSnapshot,
  issue: { number: number; url: string } | null,
): Block[] {
  const noteCount = snapshot.timeline.filter((e) => e.kind === 'note').length;
  const duration = formatDuration(incident.declaredAt, incident.resolvedAt ?? new Date().toISOString());

  const blocks: Block[] = [
    { type: 'header', text: { type: 'plain_text', text: `${incident.key} resolved`, emoji: true } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Duration*\n${duration}` },
        { type: 'mrkdwn', text: `*Severity*\n${incident.severity.toUpperCase()}` },
        { type: 'mrkdwn', text: `*Timeline entries*\n${snapshot.timeline.length} (${noteCount} note${noteCount === 1 ? '' : 's'})` },
        { type: 'mrkdwn', text: `*Changes reviewed*\n${snapshot.changes.length}` },
      ],
    },
  ];

  blocks.push(
    issue
      ? section(`:memo: Postmortem drafted → *<${issue.url}|#${issue.number}>*\nIt is a draft. Someone who was on the call needs to read it before it goes anywhere.`)
      : section(':warning: The postmortem was drafted but the GitHub issue could not be opened. The draft is stored — retrieve it via the MCP server or `/incident show`.'),
  );

  return blocks;
}

/** `/incident list` output. */
export function listBlocks(incidents: Incident[]): Block[] {
  if (incidents.length === 0) return [section('_No incidents on record._')];
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Incidents', emoji: true } },
    ...incidents.map((i) =>
      section(
        `${SEVERITY_EMOJI[i.severity] ?? ':warning:'} *${i.key}* — ${escape(truncate(i.title, 120))}\n` +
          `_${i.status}_ · declared ${formatStamp(i.declaredAt)}` +
          (i.channelId ? ` · <#${i.channelId}>` : '') +
          (i.postmortemUrl ? ` · <${i.postmortemUrl}|postmortem>` : ''),
      ),
    ),
  ];
}

export function helpBlocks(): Block[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Firebreak', emoji: true } },
    section(
      [
        '*`/incident declare [sev1|sev2|sev3] <what is broken>`*',
        'Opens a dedicated channel, posts the response template, pulls every merge and deploy from the last 48h, and has an agent rank which ones could plausibly be related.',
        '',
        '*`/incident note <what you observed>`*',
        'Appends to the incident timeline. Run it from the incident channel.',
        '',
        '*`/incident status <investigating|identified|monitoring>`*',
        'Updates the incident status.',
        '',
        '*`/incident resolve`*',
        'Closes the incident, drafts a postmortem from the timeline plus those changes, and opens it as a GitHub issue.',
        '',
        '*`/incident list [open|all]`*',
        'Recent incidents.',
      ].join('\n'),
    ),
    context('Outside an incident channel, pass a key: `/incident note INC-2026-0007 db failover finished`'),
  ];
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Slack mrkdwn control characters. */
function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

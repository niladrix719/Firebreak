import type { CorrelateInput, LlmPort } from '../core/ports.js';
import type {
  ChangeEvent,
  CorrelationFinding,
  CorrelationReport,
  IncidentSnapshot,
  Likelihood,
  Postmortem,
} from '../core/types.js';
import { formatDuration, formatStamp } from '../util/time.js';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were', 'has', 'have',
  'not', 'all', 'our', 'out', 'but', 'get', 'got', 'can', 'its', 'into', 'over', 'after',
  'some', 'users', 'user', 'issue', 'error', 'errors', 'failing', 'failed', 'broken', 'down',
]);

/** Recency weight falls to ~1/e after this many hours. */
const RECENCY_TAU_HOURS = 6;

/**
 * A deterministic stand-in for the LLM.
 *
 * It exists for two reasons. First, `npm run demo` has to work for someone who
 * cloned the repo thirty seconds ago and has no Anthropic key. Second, if the
 * Anthropic API is down during a real incident, responders still get a ranked
 * change list and a postmortem skeleton instead of an error.
 *
 * It scores on term overlap, recency, and revert markers. It is not smart, and
 * it says so in its own output.
 */
export class HeuristicLlm implements LlmPort {
  readonly model = 'heuristic-v1';

  async correlate(input: CorrelateInput): Promise<CorrelationReport> {
    const terms = tokenize(input.incident.title);
    const declaredAt = new Date(input.incident.declaredAt).getTime();

    const scored = await Promise.all(
      input.changes.map(async (change) => {
        const detail = await input.fetchDetail(change.id).catch(() => null);
        const haystack = [change.title, detail?.body ?? '', ...(detail?.filesChanged ?? [])]
          .join(' ')
          .toLowerCase();

        const overlap = [...terms].filter((t) => haystack.includes(t));
        const ageHours = Math.max(0, (declaredAt - new Date(change.at).getTime()) / 3_600_000);

        // Recency decays exponentially rather than linearly. A linear decay
        // over the window lets an old change with two keyword hits outrank the
        // deploy that went out twenty minutes ago, which is the wrong instinct
        // during an outage: what just shipped is where you look first.
        const recency = Math.exp(-ageHours / RECENCY_TAU_HOURS);
        const score = overlap.length * 2 + recency * 4 + (detail?.isRevert ? 0.75 : 0);

        return { change, detail, overlap, ageHours, score };
      }),
    );

    const rank: Record<Likelihood, number> = { high: 0, medium: 1, low: 2 };
    const withLikelihood = scored.map((s) => ({ ...s, likelihood: gradeOf(s.overlap.length, s.ageHours) }));

    // Sort on the label first so the badges a responder scans down the channel
    // are monotonic. Within a label, the composite score breaks the tie.
    withLikelihood.sort((a, b) => rank[a.likelihood] - rank[b.likelihood] || b.score - a.score);

    const findings: CorrelationFinding[] = withLikelihood
      // Above 1.0 no single weak signal can surface a change on its own: the
      // revert bonus alone is 0.75, so a two-day-old revert with no keyword
      // overlap stays out of the channel.
      .filter((s) => s.score > 1)
      .slice(0, 5)
      .map((s) => {
        const likelihood = s.likelihood;
        const reasons: string[] = [];
        if (s.overlap.length > 0) reasons.push(`mentions ${s.overlap.map((t) => `"${t}"`).join(', ')}`);
        if (s.detail?.isRevert) reasons.push('looks like a revert or hotfix');
        if (s.ageHours < 2) reasons.push(`shipped ${Math.round(s.ageHours * 60)}m before the incident`);
        else reasons.push(`shipped ${s.ageHours.toFixed(1)}h before the incident`);
        if (s.detail) reasons.push(`touches ${s.detail.filesChanged.length} file(s)`);

        return {
          changeId: s.change.id,
          ref: s.change.prNumber ? `#${s.change.prNumber}` : s.change.id,
          title: s.change.title,
          url: s.change.url,
          likelihood,
          reasoning: `Keyword and recency match: ${reasons.join('; ')}.`,
        };
      });

    return {
      summary:
        findings.length > 0
          ? `Ranked ${input.changes.length} change(s) by term overlap with the incident title and by recency. Top suspect: ${findings[0]!.ref} — ${findings[0]!.title}. This is a keyword match, not an analysis; verify before acting.`
          : `Ranked ${input.changes.length} change(s); none share terms with the incident title. Set ANTHROPIC_API_KEY for a real correlation pass.`,
      findings,
      suggestedChecks: [
        'Open the top-ranked change and check whether it touches the failing path.',
        'Compare the incident start time against the deploy timeline.',
        'Set ANTHROPIC_API_KEY to enable the agentic correlation pass.',
      ],
      toolCalls: input.changes.length,
      model: this.model,
      degraded: 'no Anthropic API key configured; using keyword heuristics',
    };
  }

  async draftPostmortem(snapshot: IncidentSnapshot): Promise<Postmortem> {
    const { incident, timeline, changes, correlation } = snapshot;
    const resolvedAt = incident.resolvedAt ?? new Date().toISOString();
    const notes = timeline.filter((e) => e.kind === 'note');

    const markdown = [
      `# ${incident.key} — ${incident.title}`,
      '',
      '> Drafted without an LLM (no `ANTHROPIC_API_KEY` set). This is a structured',
      '> transcription of the timeline, not an analysis. Fill in the sections marked TODO.',
      '',
      '## Summary',
      '',
      `A ${incident.severity.toUpperCase()} incident was declared at ${formatStamp(incident.declaredAt)} by ${incident.declaredByName} and resolved at ${formatStamp(resolvedAt)}, lasting ${formatDuration(incident.declaredAt, resolvedAt)}. Reported symptom: ${incident.title}.`,
      '',
      '## Impact',
      '',
      'TODO — the timeline does not record user-facing impact. Add scope and duration.',
      '',
      '## Timeline',
      '',
      ...(timeline.length
        ? timeline.map((e) => `- **${formatStamp(e.at)}** — ${e.authorName}: ${e.text}`)
        : ['- No entries were recorded.']),
      '',
      '## Root Cause',
      '',
      'TODO — not confirmed during the incident.',
      correlation && correlation.findings.length > 0
        ? `\nLeading hypotheses from the correlation pass:\n${correlation.findings
            .map((f) => `- [${f.likelihood}] [${f.ref}](${f.url}) — ${f.reasoning}`)
            .join('\n')}`
        : '',
      '',
      '## Changes Shipped Beforehand',
      '',
      ...(changes.length
        ? changes.map((c) => `- ${formatStamp(c.at)} — [${c.title}](${c.url}) (${c.author})`)
        : ['- No merges or deployments in the lookback window.']),
      '',
      '## Contributing Factors',
      '',
      'TODO',
      '',
      '## Action Items',
      '',
      ...(notes.length
        ? ['- [ ] @TODO — review the responder notes below and turn each into an action item.']
        : ['- [ ] @TODO']),
      '',
    ]
      .filter((line) => line !== undefined)
      .join('\n');

    return {
      title: `${incident.key}: ${incident.title}`,
      markdown,
      labels: ['postmortem', incident.severity],
    };
  }
}

/**
 * A change is only a strong keyword suspect when it both mentions the symptom
 * and shipped recently. Term overlap alone promotes anything that happens to
 * name the affected subsystem, which for a checkout outage is most of the repo.
 */
function gradeOf(overlapCount: number, ageHours: number): Likelihood {
  if (overlapCount > 0 && ageHours <= 2) return 'high';
  if (overlapCount > 0 || ageHours <= 1) return 'medium';
  return 'low';
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/** Exported for tests — the same shape the correlator sees. */
export type { ChangeEvent };

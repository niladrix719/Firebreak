import Anthropic from '@anthropic-ai/sdk';
import type { CorrelateInput, LlmPort } from '../core/ports.js';
import type {
  ChangeDetail,
  ChangeEvent,
  CorrelationFinding,
  CorrelationReport,
  IncidentSnapshot,
  Postmortem,
} from '../core/types.js';
import { UpstreamError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { withRetry } from '../util/retry.js';
import {
  CORRELATION_SYSTEM,
  POSTMORTEM_SYSTEM,
  correlationUserPrompt,
  postmortemUserPrompt,
} from './prompts.js';
import {
  CORRELATION_TOOLS,
  POSTMORTEM_TOOLS,
  submitPostmortemSchema,
  submitReportSchema,
} from './tools.js';

type MessageParam = Anthropic.Messages.MessageParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

export interface AnthropicLlmOptions {
  apiKey: string;
  model: string;
  /** Safety valve on the agent loop: each turn is one round-trip. */
  maxTurns?: number;
  client?: Anthropic;
}

export class AnthropicLlm implements LlmPort {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly maxTurns: number;

  constructor(opts: AnthropicLlmOptions) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.maxTurns = opts.maxTurns ?? 8;
  }

  /**
   * The agentic bit: the model is handed a candidate list and two read tools,
   * and decides for itself which changes are worth pulling a diff for. We keep
   * looping until it calls `submit_report` or we hit the turn budget, at which
   * point we force the report so an incident channel always gets an answer.
   */
  async correlate(input: CorrelateInput): Promise<CorrelationReport> {
    const byId = new Map(input.changes.map((c) => [c.id, c]));
    const detailCache = new Map<string, ChangeDetail | null>();

    const fetchDetail = async (changeId: string): Promise<ChangeDetail | null> => {
      if (detailCache.has(changeId)) return detailCache.get(changeId) ?? null;
      const detail = await input.fetchDetail(changeId);
      detailCache.set(changeId, detail);
      return detail;
    };

    const messages: MessageParam[] = [
      { role: 'user', content: correlationUserPrompt({ ...input.incident, changes: input.changes }) },
    ];

    let toolCalls = 0;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const lastTurn = turn === this.maxTurns - 1;
      const response = await this.send({
        system: CORRELATION_SYSTEM,
        messages,
        tools: CORRELATION_TOOLS,
        maxTokens: 4096,
        // On the final turn, stop investigating and commit to an answer.
        toolChoice: lastTurn ? { type: 'tool', name: 'submit_report' } : { type: 'auto' },
        label: 'correlate',
      });

      messages.push({ role: 'assistant', content: response.content as ContentBlockParam[] });

      const toolUses = response.content.filter((block) => block.type === 'tool_use');
      if (toolUses.length === 0) {
        // The model answered in prose instead of calling the tool. Nudge once.
        messages.push({
          role: 'user',
          content: 'Call submit_report now with your conclusions.',
        });
        continue;
      }

      const report = toolUses.find((block) => block.name === 'submit_report');
      if (report) {
        toolCalls += toolUses.length;
        return this.buildReport(report.input, byId, toolCalls);
      }

      const results: ContentBlockParam[] = [];
      for (const use of toolUses) {
        toolCalls++;
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: await this.runTool(use.name, use.input, byId, fetchDetail),
        });
      }
      messages.push({ role: 'user', content: results });
    }

    // Unreachable in practice — the last turn forces submit_report.
    return degraded(input.changes, this.model, 'agent did not produce a report within its turn budget');
  }

  private async runTool(
    name: string,
    rawInput: unknown,
    byId: Map<string, ChangeEvent>,
    fetchDetail: (id: string) => Promise<ChangeDetail | null>,
  ): Promise<string> {
    const args = (rawInput ?? {}) as Record<string, unknown>;
    try {
      if (name === 'inspect_change') {
        const changeId = String(args.change_id ?? '');
        const change = byId.get(changeId);
        if (!change) {
          return json({ error: `unknown change_id "${changeId}"`, valid_ids: [...byId.keys()] });
        }
        const detail = await fetchDetail(changeId);
        if (!detail) return json({ ...summarize(change), detail: 'unavailable (GitHub did not return a diff)' });
        return json({
          ...summarize(change),
          description: detail.body,
          files_changed: detail.filesChanged.slice(0, 60),
          files_changed_total: detail.filesChanged.length,
          additions: detail.additions,
          deletions: detail.deletions,
          is_revert_or_hotfix: detail.isRevert,
        });
      }

      if (name === 'find_changes_touching') {
        const needle = String(args.path_substring ?? '').toLowerCase();
        if (!needle) return json({ error: 'path_substring must not be empty' });
        const matches: unknown[] = [];
        for (const change of byId.values()) {
          const detail = await fetchDetail(change.id);
          const files = (detail?.filesChanged ?? []).filter((f) => f.toLowerCase().includes(needle));
          if (files.length > 0) matches.push({ ...summarize(change), matching_files: files.slice(0, 20) });
        }
        return json({ query: needle, match_count: matches.length, matches });
      }

      return json({ error: `unknown tool "${name}"` });
    } catch (err) {
      logger.warn({ err, tool: name }, 'correlation tool failed');
      return json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  private buildReport(rawInput: unknown, byId: Map<string, ChangeEvent>, toolCalls: number): CorrelationReport {
    const parsed = submitReportSchema.safeParse(rawInput);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, 'submit_report failed validation');
      return degraded([...byId.values()], this.model, 'the agent returned a malformed report');
    }

    const findings: CorrelationFinding[] = [];
    for (const f of parsed.data.findings) {
      // Drop hallucinated ids rather than showing responders a dead link.
      const change = byId.get(f.change_id);
      if (!change) {
        logger.warn({ changeId: f.change_id }, 'dropping finding for an unknown change id');
        continue;
      }
      findings.push({
        changeId: change.id,
        ref: change.prNumber ? `#${change.prNumber}` : change.id,
        title: change.title,
        url: change.url,
        likelihood: f.likelihood,
        reasoning: f.reasoning,
      });
    }

    const rank = { high: 0, medium: 1, low: 2 } as const;
    findings.sort((a, b) => rank[a.likelihood] - rank[b.likelihood]);

    return {
      summary: parsed.data.summary,
      findings,
      suggestedChecks: parsed.data.suggested_checks,
      toolCalls,
      model: this.model,
    };
  }

  async draftPostmortem(snapshot: IncidentSnapshot): Promise<Postmortem> {
    const response = await this.send({
      system: POSTMORTEM_SYSTEM,
      messages: [{ role: 'user', content: postmortemUserPrompt(snapshot) }],
      tools: POSTMORTEM_TOOLS,
      maxTokens: 8192,
      toolChoice: { type: 'tool', name: 'submit_postmortem' },
      label: 'postmortem',
    });

    const use = response.content.find((block) => block.type === 'tool_use');
    const parsed = submitPostmortemSchema.safeParse(use?.input);
    if (!parsed.success) {
      throw new UpstreamError('anthropic', 'the model returned a malformed postmortem');
    }

    const labels = new Set([...parsed.data.labels, 'postmortem', snapshot.incident.severity]);
    return { title: parsed.data.title, markdown: parsed.data.markdown, labels: [...labels] };
  }

  private async send(args: {
    system: string;
    messages: MessageParam[];
    tools: Anthropic.Messages.Tool[];
    maxTokens: number;
    toolChoice: Anthropic.Messages.ToolChoice;
    label: string;
  }): Promise<Anthropic.Messages.Message> {
    try {
      return await withRetry(
        () =>
          this.client.messages.create({
            model: this.model,
            max_tokens: args.maxTokens,
            system: args.system,
            tools: args.tools,
            tool_choice: args.toolChoice,
            messages: args.messages,
          }),
        { label: `anthropic.${args.label}` },
      );
    } catch (err) {
      throw new UpstreamError('anthropic', `${args.label} call failed`, err);
    }
  }
}

function summarize(change: ChangeEvent) {
  return {
    id: change.id,
    kind: change.kind,
    title: change.title,
    author: change.author,
    merged_or_deployed_at: change.at,
    environment: change.environment,
    url: change.url,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function degraded(changes: ChangeEvent[], model: string, reason: string): CorrelationReport {
  return {
    summary: `Automated correlation is unavailable (${reason}). ${changes.length} change(s) shipped in the lookback window and are listed below for manual review.`,
    findings: [],
    suggestedChecks: ['Review the change list manually.'],
    toolCalls: 0,
    model,
    degraded: reason,
  };
}

import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicLlm } from '../src/llm/anthropic.js';
import type { CorrelateInput } from '../src/core/ports.js';
import type { ChangeDetail, ChangeEvent } from '../src/core/types.js';
import { storefrontChanges } from '../src/testing/fixtures.js';
import { UpstreamError } from '../src/util/errors.js';

const DECLARED_AT = new Date('2026-09-01T14:00:00.000Z');
const FIXTURES = storefrontChanges(DECLARED_AT);
const CHANGES: ChangeEvent[] = FIXTURES.map(({ detail: _d, ...rest }) => rest);
const DETAILS = new Map<string, ChangeDetail>(FIXTURES.map((c) => [c.id, c.detail]));

type CreateArgs = Anthropic.Messages.MessageCreateParamsNonStreaming;

/** Builds a stub Anthropic client that replays a fixed script of responses. */
function stubClient(script: Anthropic.Messages.ContentBlock[][]) {
  const calls: CreateArgs[] = [];
  const create = vi.fn(async (args: CreateArgs) => {
    // Snapshot the message list: the agent mutates the array it passes in, so
    // holding the reference would let later turns rewrite what we recorded.
    calls.push({ ...args, messages: [...args.messages] });
    const content = script[Math.min(calls.length - 1, script.length - 1)]!;
    return {
      id: `msg_${calls.length}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content,
      stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 10 },
    } as unknown as Anthropic.Messages.Message;
  });
  return { calls, client: { messages: { create } } as unknown as Anthropic };
}

const toolUse = (id: string, name: string, input: unknown): Anthropic.Messages.ContentBlock =>
  ({ type: 'tool_use', id, name, input }) as Anthropic.Messages.ContentBlock;

const text = (value: string): Anthropic.Messages.ContentBlock =>
  ({ type: 'text', text: value, citations: null }) as Anthropic.Messages.ContentBlock;

function correlateInput(overrides: Partial<CorrelateInput> = {}): CorrelateInput {
  return {
    incident: {
      key: 'INC-2026-0001',
      title: 'Checkout API returning 502s',
      severity: 'sev2',
      declaredAt: DECLARED_AT.toISOString(),
    },
    changes: CHANGES,
    fetchDetail: async (id) => DETAILS.get(id) ?? null,
    ...overrides,
  };
}

const REPORT = {
  summary: 'The Redis session migration is the leading suspect.',
  findings: [
    { change_id: 'pr:482', likelihood: 'high', reasoning: 'Touches services/checkout/session.ts and sizes the pool at 384 against maxclients 512.' },
    { change_id: 'pr:481', likelihood: 'low', reasoning: 'Content only; touches no code that runs.' },
  ],
  suggested_checks: ['Check Redis connected_clients against maxclients.'],
};

describe('AnthropicLlm.correlate', () => {
  it('runs a tool loop and returns the report the model submits', async () => {
    const { client, calls } = stubClient([
      [toolUse('t1', 'inspect_change', { change_id: 'pr:482' })],
      [toolUse('t2', 'submit_report', REPORT)],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'claude-sonnet-5', client });

    const report = await llm.correlate(correlateInput());

    expect(calls).toHaveLength(2);
    expect(report.summary).toBe(REPORT.summary);
    expect(report.model).toBe('claude-sonnet-5');
    expect(report.toolCalls).toBe(2);
    expect(report.degraded).toBeUndefined();
  });

  it('feeds the diff back to the model as a tool result', async () => {
    const { client, calls } = stubClient([
      [toolUse('t1', 'inspect_change', { change_id: 'pr:482' })],
      [toolUse('t2', 'submit_report', REPORT)],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    await llm.correlate(correlateInput());

    const resultMessage = calls[1]!.messages.at(-1)!;
    const block = (resultMessage.content as Anthropic.Messages.ContentBlockParam[])[0]!;
    expect(block.type).toBe('tool_result');
    const payload = String((block as Anthropic.Messages.ToolResultBlockParam).content);
    expect(payload).toContain('services/checkout/session.ts');
    expect(payload).toContain('"additions": 214');
  });

  it('resolves findings against the real change list', async () => {
    const { client } = stubClient([[toolUse('t1', 'submit_report', REPORT)]]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    const report = await llm.correlate(correlateInput());

    expect(report.findings[0]).toMatchObject({
      changeId: 'pr:482',
      ref: '#482',
      url: 'https://github.com/acme/storefront/pull/482',
      likelihood: 'high',
    });
  });

  it('drops findings that name a change that does not exist', async () => {
    const { client } = stubClient([
      [
        toolUse('t1', 'submit_report', {
          ...REPORT,
          findings: [
            { change_id: 'pr:9999', likelihood: 'high', reasoning: 'invented' },
            { change_id: 'pr:482', likelihood: 'medium', reasoning: 'real' },
          ],
        }),
      ],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    const report = await llm.correlate(correlateInput());

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.changeId).toBe('pr:482');
  });

  it('orders findings by likelihood', async () => {
    const { client } = stubClient([
      [
        toolUse('t1', 'submit_report', {
          ...REPORT,
          findings: [
            { change_id: 'pr:481', likelihood: 'low', reasoning: 'x' },
            { change_id: 'pr:480', likelihood: 'medium', reasoning: 'y' },
            { change_id: 'pr:482', likelihood: 'high', reasoning: 'z' },
          ],
        }),
      ],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    const report = await llm.correlate(correlateInput());

    expect(report.findings.map((f) => f.likelihood)).toEqual(['high', 'medium', 'low']);
  });

  it('serves find_changes_touching from the fetched diffs', async () => {
    const { client, calls } = stubClient([
      [toolUse('t1', 'find_changes_touching', { path_substring: 'infra/redis' })],
      [toolUse('t2', 'submit_report', REPORT)],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    await llm.correlate(correlateInput());

    const block = (calls[1]!.messages.at(-1)!.content as Anthropic.Messages.ContentBlockParam[])[0]!;
    const payload = JSON.parse(String((block as Anthropic.Messages.ToolResultBlockParam).content));
    expect(payload.match_count).toBeGreaterThan(0);
    expect(JSON.stringify(payload.matches)).toContain('infra/redis/production.tf');
  });

  it('tells the model when it names a change id that does not exist', async () => {
    const { client, calls } = stubClient([
      [toolUse('t1', 'inspect_change', { change_id: 'pr:0' })],
      [toolUse('t2', 'submit_report', REPORT)],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    await llm.correlate(correlateInput());

    const block = (calls[1]!.messages.at(-1)!.content as Anthropic.Messages.ContentBlockParam[])[0]!;
    const payload = JSON.parse(String((block as Anthropic.Messages.ToolResultBlockParam).content));
    expect(payload.error).toContain('unknown change_id');
    expect(payload.valid_ids).toContain('pr:482');
  });

  it('nudges the model when it answers in prose instead of calling the tool', async () => {
    const { client, calls } = stubClient([
      [text('I think it was the Redis change.')],
      [toolUse('t1', 'submit_report', REPORT)],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    const report = await llm.correlate(correlateInput());

    expect(calls[1]!.messages.at(-1)!.content).toContain('submit_report');
    expect(report.summary).toBe(REPORT.summary);
  });

  it('forces submit_report on the final turn so an answer always lands', async () => {
    // A model that never stops investigating.
    const { client, calls } = stubClient([[toolUse('t', 'inspect_change', { change_id: 'pr:482' })]]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client, maxTurns: 3 });

    await llm.correlate(correlateInput());

    expect(calls).toHaveLength(3);
    expect(calls[0]!.tool_choice).toEqual({ type: 'auto' });
    expect(calls.at(-1)!.tool_choice).toEqual({ type: 'tool', name: 'submit_report' });
  });

  it('degrades rather than throwing when the report fails validation', async () => {
    const { client } = stubClient([[toolUse('t1', 'submit_report', { summary: 42 })]]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    const report = await llm.correlate(correlateInput());

    expect(report.degraded).toMatch(/malformed/);
    expect(report.findings).toEqual([]);
    expect(report.summary).toContain('7 change(s)');
  });

  it('caches diffs so one change is never fetched twice', async () => {
    const fetchDetail = vi.fn(async (id: string) => DETAILS.get(id) ?? null);
    const { client } = stubClient([
      [toolUse('t1', 'inspect_change', { change_id: 'pr:482' })],
      [toolUse('t2', 'inspect_change', { change_id: 'pr:482' })],
      [toolUse('t3', 'submit_report', REPORT)],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    await llm.correlate(correlateInput({ fetchDetail }));

    expect(fetchDetail).toHaveBeenCalledTimes(1);
  });

  it('surfaces an upstream failure as an UpstreamError', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    });
    const llm = new AnthropicLlm({
      apiKey: 'k',
      model: 'm',
      client: { messages: { create } } as unknown as Anthropic,
    });

    await expect(llm.correlate(correlateInput())).rejects.toThrow(UpstreamError);
    // 4xx is not retried.
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('AnthropicLlm.draftPostmortem', () => {
  const snapshot = {
    incident: {
      id: 'inc_1',
      key: 'INC-2026-0001',
      title: 'Checkout API returning 502s',
      severity: 'sev2' as const,
      status: 'resolved' as const,
      declaredBy: 'U1',
      declaredByName: 'rhee',
      declaredAt: DECLARED_AT.toISOString(),
      resolvedAt: '2026-09-01T14:48:00.000Z',
      channelId: 'C1',
      channelName: 'inc-2026-0001',
      correlationSummary: null,
      postmortemUrl: null,
      postmortemMarkdown: null,
    },
    timeline: [
      {
        id: 'tl_1',
        incidentId: 'inc_1',
        at: DECLARED_AT.toISOString(),
        kind: 'note' as const,
        authorId: 'U1',
        authorName: 'rhee',
        text: 'redis maxclients reached',
      },
    ],
    changes: CHANGES,
    correlation: null,
  };

  it('forces the structured tool and merges the required labels', async () => {
    const { client, calls } = stubClient([
      [toolUse('t1', 'submit_postmortem', { title: 'INC-2026-0001: 502s', markdown: '## Summary\n\nx', labels: ['incident'] })],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    const postmortem = await llm.draftPostmortem(snapshot);

    expect(calls[0]!.tool_choice).toEqual({ type: 'tool', name: 'submit_postmortem' });
    expect(postmortem.title).toBe('INC-2026-0001: 502s');
    expect(postmortem.labels).toEqual(expect.arrayContaining(['incident', 'postmortem', 'sev2']));
    // No duplicates even if the model already supplied one of them.
    expect(new Set(postmortem.labels).size).toBe(postmortem.labels.length);
  });

  it('passes the verbatim timeline to the model', async () => {
    const { client, calls } = stubClient([
      [toolUse('t1', 'submit_postmortem', { title: 't', markdown: 'm', labels: [] })],
    ]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    await llm.draftPostmortem(snapshot);

    expect(String(calls[0]!.messages[0]!.content)).toContain('redis maxclients reached');
    expect(String(calls[0]!.system)).toContain('Blameless');
  });

  it('rejects a malformed postmortem rather than opening an empty issue', async () => {
    const { client } = stubClient([[toolUse('t1', 'submit_postmortem', { title: 'only a title' })]]);
    const llm = new AnthropicLlm({ apiKey: 'k', model: 'm', client });

    await expect(llm.draftPostmortem(snapshot)).rejects.toThrow(/malformed postmortem/);
  });
});

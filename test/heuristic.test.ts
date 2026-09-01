import { describe, expect, it } from 'vitest';
import { HeuristicLlm } from '../src/llm/heuristic.js';
import type { CorrelateInput } from '../src/core/ports.js';
import type { ChangeDetail, ChangeEvent, IncidentSnapshot } from '../src/core/types.js';
import { storefrontChanges } from '../src/testing/fixtures.js';

const DECLARED_AT = new Date('2026-09-01T14:00:00.000Z');
const FIXTURES = storefrontChanges(DECLARED_AT);
const CHANGES: ChangeEvent[] = FIXTURES.map(({ detail: _d, ...rest }) => rest);
const DETAILS = new Map<string, ChangeDetail>(FIXTURES.map((c) => [c.id, c.detail]));

function input(overrides: Partial<CorrelateInput> = {}): CorrelateInput {
  return {
    incident: {
      key: 'INC-2026-0001',
      title: 'Checkout API returning 502s for roughly 15% of requests',
      severity: 'sev2',
      declaredAt: DECLARED_AT.toISOString(),
    },
    changes: CHANGES,
    fetchDetail: async (id) => DETAILS.get(id) ?? null,
    ...overrides,
  };
}

describe('HeuristicLlm.correlate', () => {
  it('always marks itself degraded so nobody mistakes it for analysis', async () => {
    const report = await new HeuristicLlm().correlate(input());
    expect(report.degraded).toMatch(/no Anthropic API key/);
    expect(report.summary).toMatch(/keyword match, not an analysis/);
    expect(report.model).toBe('heuristic-v1');
  });

  it('ranks what shipped minutes ago above an older change with more keyword hits', async () => {
    const report = await new HeuristicLlm().correlate(input());
    const ids = report.findings.map((f) => f.changeId);

    // pr:479 mentions both "checkout" and "502s" but shipped 20 hours earlier.
    // The deploy and the Redis PR went out within the hour.
    expect(ids.indexOf('deploy:99182')).toBeLessThan(ids.indexOf('pr:479'));
    expect(ids.indexOf('pr:482')).toBeLessThan(ids.indexOf('pr:479'));
  });

  it('emits likelihood labels in non-increasing order', async () => {
    const report = await new HeuristicLlm().correlate(input());
    const rank = { high: 0, medium: 1, low: 2 };
    const ranks = report.findings.map((f) => rank[f.likelihood]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('returns at most five findings', async () => {
    const report = await new HeuristicLlm().correlate(input());
    expect(report.findings.length).toBeLessThanOrEqual(5);
  });

  it('cites what it matched on', async () => {
    const report = await new HeuristicLlm().correlate(input());
    expect(report.findings[0]!.reasoning).toMatch(/mentions "checkout"|shipped/);
    expect(report.findings[0]!.reasoning).toContain('file(s)');
  });

  it('says plainly when nothing matches', async () => {
    const report = await new HeuristicLlm().correlate(
      input({
        incident: {
          key: 'INC-2026-0002',
          title: 'Kubernetes ingress certificates expired',
          severity: 'sev1',
          declaredAt: new Date(DECLARED_AT.getTime() + 40 * 3_600_000).toISOString(),
        },
      }),
    );
    expect(report.findings).toEqual([]);
    expect(report.summary).toContain('none share terms');
  });

  it('handles an empty change list', async () => {
    const report = await new HeuristicLlm().correlate(input({ changes: [] }));
    expect(report.findings).toEqual([]);
    expect(report.summary).toContain('0 change(s)');
  });

  it('survives a diff lookup that throws', async () => {
    const report = await new HeuristicLlm().correlate(
      input({
        fetchDetail: async () => {
          throw new Error('GitHub is down');
        },
      }),
    );
    expect(report.findings.length).toBeGreaterThan(0);
  });
});

describe('HeuristicLlm.draftPostmortem', () => {
  const snapshot: IncidentSnapshot = {
    incident: {
      id: 'inc_1',
      key: 'INC-2026-0001',
      title: 'Checkout API returning 502s',
      severity: 'sev2',
      status: 'resolved',
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
        kind: 'note',
        authorId: 'U1',
        authorName: 'rhee',
        text: 'redis maxclients reached',
      },
    ],
    changes: CHANGES,
    correlation: null,
  };

  it('produces the standard sections and flags itself as machine-written', async () => {
    const { markdown, title, labels } = await new HeuristicLlm().draftPostmortem(snapshot);

    expect(title).toBe('INC-2026-0001: Checkout API returning 502s');
    expect(labels).toEqual(['postmortem', 'sev2']);
    for (const section of ['## Summary', '## Impact', '## Timeline', '## Root Cause', '## Action Items']) {
      expect(markdown).toContain(section);
    }
    expect(markdown).toContain('Drafted without an LLM');
    expect(markdown).toContain('redis maxclients reached');
    expect(markdown).toContain('lasting 48m');
  });

  it('marks unknown sections TODO rather than inventing content', async () => {
    const { markdown } = await new HeuristicLlm().draftPostmortem(snapshot);
    expect(markdown).toMatch(/## Impact\n\nTODO/);
    expect(markdown).toMatch(/## Root Cause\n\nTODO/);
  });

  it('handles an incident with no timeline and no changes', async () => {
    const { markdown } = await new HeuristicLlm().draftPostmortem({
      ...snapshot,
      timeline: [],
      changes: [],
    });
    expect(markdown).toContain('No entries were recorded.');
    expect(markdown).toContain('No merges or deployments in the lookback window.');
  });
});

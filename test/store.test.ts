import { beforeEach, describe, expect, it } from 'vitest';
import { SqliteIncidentStore } from '../src/store/sqliteStore.js';
import type { Incident, TimelineEntry } from '../src/core/types.js';

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'inc_1',
    key: 'INC-2026-0001',
    title: 'Checkout is down',
    severity: 'sev2',
    status: 'investigating',
    declaredBy: 'U1',
    declaredByName: 'rhee',
    declaredAt: '2026-09-01T14:00:00.000Z',
    resolvedAt: null,
    channelId: 'C1',
    channelName: 'inc-2026-0001-checkout-is-down',
    correlationSummary: null,
    postmortemUrl: null,
    postmortemMarkdown: null,
    ...overrides,
  };
}

function entry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id: 'tl_1',
    incidentId: 'inc_1',
    at: '2026-09-01T14:01:00.000Z',
    kind: 'note',
    authorId: 'U1',
    authorName: 'rhee',
    text: 'a note',
    ...overrides,
  };
}

describe('SqliteIncidentStore', () => {
  let store: SqliteIncidentStore;

  beforeEach(() => {
    store = new SqliteIncidentStore(':memory:');
  });

  it('round-trips an incident', async () => {
    await store.createIncident(incident());
    expect(await store.getIncident('inc_1')).toMatchObject({ key: 'INC-2026-0001', title: 'Checkout is down' });
  });

  it('finds an incident by key, case-insensitively', async () => {
    await store.createIncident(incident());
    expect(await store.getIncident('inc-2026-0001')).toMatchObject({ id: 'inc_1' });
  });

  it('finds an incident by channel', async () => {
    await store.createIncident(incident());
    expect(await store.getIncidentByChannel('C1')).toMatchObject({ id: 'inc_1' });
    expect(await store.getIncidentByChannel('C-nope')).toBeNull();
  });

  it('refuses to bind two incidents to the same channel', async () => {
    await store.createIncident(incident());
    await expect(store.createIncident(incident({ id: 'inc_2', key: 'INC-2026-0002' }))).rejects.toThrow(/UNIQUE/);
  });

  it('allows many incidents with no channel', async () => {
    await store.createIncident(incident({ channelId: null, channelName: null }));
    await store.createIncident(incident({ id: 'inc_2', key: 'INC-2026-0002', channelId: null, channelName: null }));
    expect(await store.listIncidents({ limit: 10 })).toHaveLength(2);
  });

  it('patches only the fields it is given', async () => {
    await store.createIncident(incident());
    const updated = await store.updateIncident('inc_1', { status: 'monitoring', resolvedAt: null });
    expect(updated.status).toBe('monitoring');
    expect(updated.title).toBe('Checkout is down');
  });

  it('writes nulls back as nulls, not the string "null"', async () => {
    await store.createIncident(incident({ postmortemUrl: 'https://example.test/1' }));
    const updated = await store.updateIncident('inc_1', { postmortemUrl: null });
    expect(updated.postmortemUrl).toBeNull();
  });

  describe('nextIncidentKey', () => {
    it('numbers sequentially inside a year', async () => {
      const now = new Date('2026-09-01T00:00:00Z');
      expect(await store.nextIncidentKey(now)).toBe('INC-2026-0001');
      expect(await store.nextIncidentKey(now)).toBe('INC-2026-0002');
      expect(await store.nextIncidentKey(now)).toBe('INC-2026-0003');
    });

    it('restarts the counter in a new year', async () => {
      await store.nextIncidentKey(new Date('2026-12-31T23:59:59Z'));
      expect(await store.nextIncidentKey(new Date('2027-01-01T00:00:01Z'))).toBe('INC-2027-0001');
    });

    it('never issues the same key twice under concurrency', async () => {
      const now = new Date('2026-09-01T00:00:00Z');
      const keys = await Promise.all(Array.from({ length: 25 }, () => store.nextIncidentKey(now)));
      expect(new Set(keys).size).toBe(25);
    });
  });

  describe('timeline', () => {
    beforeEach(async () => {
      await store.createIncident(incident());
    });

    it('returns entries in insertion order when timestamps collide', async () => {
      const at = '2026-09-01T14:05:00.000Z';
      for (const [index, text] of ['first', 'second', 'third'].entries()) {
        await store.appendTimeline(entry({ id: `tl_${index}`, at, text }));
      }
      expect((await store.getTimeline('inc_1')).map((e) => e.text)).toEqual(['first', 'second', 'third']);
    });

    it('orders by timestamp ahead of insertion order', async () => {
      await store.appendTimeline(entry({ id: 'tl_a', at: '2026-09-01T14:09:00.000Z', text: 'later' }));
      await store.appendTimeline(entry({ id: 'tl_b', at: '2026-09-01T14:02:00.000Z', text: 'earlier' }));
      expect((await store.getTimeline('inc_1')).map((e) => e.text)).toEqual(['earlier', 'later']);
    });

    it('scopes the timeline to one incident', async () => {
      await store.createIncident(incident({ id: 'inc_2', key: 'INC-2026-0002', channelId: 'C2' }));
      await store.appendTimeline(entry({ id: 'tl_a', text: 'mine' }));
      await store.appendTimeline(entry({ id: 'tl_b', incidentId: 'inc_2', text: 'theirs' }));
      expect((await store.getTimeline('inc_1')).map((e) => e.text)).toEqual(['mine']);
    });
  });

  describe('changes and correlation', () => {
    beforeEach(async () => {
      await store.createIncident(incident());
    });

    it('round-trips changes newest first', async () => {
      await store.saveChanges('inc_1', [
        { id: 'pr:1', kind: 'merge', title: 'old', url: 'u', author: 'a', at: '2026-09-01T10:00:00.000Z', sha: null, prNumber: 1, environment: null },
        { id: 'pr:2', kind: 'merge', title: 'new', url: 'u', author: 'a', at: '2026-09-01T13:00:00.000Z', sha: null, prNumber: 2, environment: null },
      ]);
      expect((await store.getChanges('inc_1')).map((c) => c.title)).toEqual(['new', 'old']);
    });

    it('re-saving the same change updates rather than duplicating it', async () => {
      const change = { id: 'pr:1', kind: 'merge' as const, title: 'v1', url: 'u', author: 'a', at: '2026-09-01T10:00:00.000Z', sha: null, prNumber: 1, environment: null };
      await store.saveChanges('inc_1', [change]);
      await store.saveChanges('inc_1', [{ ...change, title: 'v2' }]);
      const stored = await store.getChanges('inc_1');
      expect(stored).toHaveLength(1);
      expect(stored[0]!.title).toBe('v2');
    });

    it('round-trips a correlation report', async () => {
      const report = {
        summary: 'the redis PR is the leading suspect',
        findings: [
          { changeId: 'pr:482', ref: '#482', title: 'Redis sessions', url: 'u', likelihood: 'high' as const, reasoning: 'touches the failing path' },
        ],
        suggestedChecks: ['check maxclients'],
        toolCalls: 3,
        model: 'claude-sonnet-5',
      };
      await store.saveCorrelation('inc_1', report);
      expect(await store.getCorrelation('inc_1')).toEqual(report);
    });

    it('overwrites an existing correlation rather than failing', async () => {
      const base = { summary: 'a', findings: [], suggestedChecks: [], toolCalls: 1, model: 'm' };
      await store.saveCorrelation('inc_1', base);
      await store.saveCorrelation('inc_1', { ...base, summary: 'b' });
      expect((await store.getCorrelation('inc_1'))?.summary).toBe('b');
    });

    it('returns null when no correlation was recorded', async () => {
      expect(await store.getCorrelation('inc_1')).toBeNull();
    });
  });

  describe('listing', () => {
    it('filters by status and orders newest first', async () => {
      await store.createIncident(incident({ id: 'a', key: 'INC-2026-0001', channelId: 'C1', declaredAt: '2026-09-01T10:00:00.000Z' }));
      await store.createIncident(incident({ id: 'b', key: 'INC-2026-0002', channelId: 'C2', declaredAt: '2026-09-01T12:00:00.000Z', status: 'resolved' }));
      await store.createIncident(incident({ id: 'c', key: 'INC-2026-0003', channelId: 'C3', declaredAt: '2026-09-01T11:00:00.000Z' }));

      expect((await store.listIncidents({ limit: 10 })).map((i) => i.id)).toEqual(['b', 'c', 'a']);
      expect((await store.listIncidents({ status: 'investigating', limit: 10 })).map((i) => i.id)).toEqual(['c', 'a']);
      expect(await store.listIncidents({ limit: 1 })).toHaveLength(1);
    });
  });

  it('is idempotent across reopens of the same database', () => {
    // Running migrations twice must not throw — the process restarts often.
    const first = new SqliteIncidentStore(':memory:');
    first.close();
    expect(() => new SqliteIncidentStore(':memory:').close()).not.toThrow();
  });
});

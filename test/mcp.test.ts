import { beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { registerIncidentTools } from '../src/mcp/tools.js';
import { IncidentService } from '../src/core/incidentService.js';
import { SqliteIncidentStore } from '../src/store/sqliteStore.js';
import { HeuristicLlm } from '../src/llm/heuristic.js';
import { FakeChat, FakeGitHub } from '../src/testing/fakes.js';
import { storefrontChanges } from '../src/testing/fixtures.js';

const ACTOR = { id: 'U0RHEE', name: 'rhee' };
const DECLARED_AT = new Date('2026-09-01T14:00:00.000Z');

async function textOf(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return content.map((c) => c.text).join('\n');
}

describe('MCP tools', () => {
  let store: SqliteIncidentStore;
  let client: Client;
  let github: FakeGitHub;

  beforeEach(async () => {
    store = new SqliteIncidentStore(':memory:');
    github = new FakeGitHub(storefrontChanges(DECLARED_AT));

    let cursor = DECLARED_AT.getTime();
    const clock = () => new Date((cursor += 60_000) - 60_000);
    const service = new IncidentService(
      { store, chat: new FakeChat(), github, llm: new HeuristicLlm() },
      { lookbackHours: 48, lookbackLimit: 30, clock },
    );

    const declared = await service.declare({
      title: 'Checkout API returning 502s',
      severity: 'sev2',
      actor: ACTOR,
    });
    await declared.investigate();
    await service.addNote({
      ref: { channelId: declared.channel!.id },
      text: 'redis maxclients reached',
      actor: ACTOR,
    });
    await service.resolve({ ref: { channelId: declared.channel!.id }, actor: ACTOR });

    // A second, older, still-open incident to make filters meaningful.
    let older = new Date('2026-08-20T09:00:00.000Z').getTime();
    const olderService = new IncidentService(
      { store, chat: new FakeChat(), github: new FakeGitHub([]), llm: new HeuristicLlm() },
      { lookbackHours: 48, lookbackLimit: 30, clock: () => new Date((older += 60_000) - 60_000) },
    );
    await olderService.declare({ title: 'Search latency above SLO', severity: 'sev3', actor: ACTOR });

    const server = new McpServer({ name: 'firebreak-test', version: '1.0.0' }, { capabilities: { tools: {} } });
    registerIncidentTools(server, { store, github, z });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  it('exposes exactly the three documented tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_timeline', 'list_incidents', 'recent_changes']);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  describe('list_incidents', () => {
    it('lists everything, newest first', async () => {
      const output = await textOf(client, 'list_incidents', {});
      expect(output).toContain('2 incident(s)');
      expect(output.indexOf('INC-2026-0001')).toBeLessThan(output.indexOf('INC-2026-0002'));
    });

    it('filters by status', async () => {
      const output = await textOf(client, 'list_incidents', { status: 'resolved' });
      expect(output).toContain('INC-2026-0001');
      expect(output).not.toContain('INC-2026-0002');
    });

    it('filters by severity', async () => {
      expect(await textOf(client, 'list_incidents', { severity: 'sev3' })).toContain('Search latency');
    });

    it('filters by a bare date window, inclusive of the whole day', async () => {
      const sameDay = await textOf(client, 'list_incidents', { since: '2026-09-01', until: '2026-09-01' });
      expect(sameDay).toContain('INC-2026-0001');
      expect(sameDay).not.toContain('Search latency');
    });

    it('filters by title text', async () => {
      expect(await textOf(client, 'list_incidents', { query: 'checkout' })).toContain('INC-2026-0001');
      expect(await textOf(client, 'list_incidents', { query: 'kubernetes' })).toContain('No incidents matched');
    });

    it('reports duration and postmortem link for a resolved incident', async () => {
      const output = await textOf(client, 'list_incidents', { status: 'resolved' });
      expect(output).toMatch(/resolved after \d+m/);
      expect(output).toContain('postmortem: https://github.com/acme/storefront/issues/');
    });
  });

  describe('get_timeline', () => {
    it('returns metadata, the timeline, and the correlation', async () => {
      const output = await textOf(client, 'get_timeline', { incident: 'INC-2026-0001' });
      expect(output).toContain('# INC-2026-0001');
      expect(output).toContain('redis maxclients reached');
      expect(output).toContain('## Correlation at declare time');
      expect(output).toContain('Severity: SEV2');
    });

    it('accepts a lowercase key', async () => {
      expect(await textOf(client, 'get_timeline', { incident: 'inc-2026-0001' })).toContain('# INC-2026-0001');
    });

    it('omits changes unless asked', async () => {
      const without = await textOf(client, 'get_timeline', { incident: 'INC-2026-0001' });
      const with_ = await textOf(client, 'get_timeline', { incident: 'INC-2026-0001', include_changes: true });
      expect(without).not.toContain('## Changes captured at declare time');
      expect(with_).toContain('## Changes captured at declare time');
    });

    it('points at list_incidents when the key is wrong', async () => {
      const output = await textOf(client, 'get_timeline', { incident: 'INC-1999-0001' });
      expect(output).toContain('No incident matching');
      expect(output).toContain('list_incidents');
    });
  });

  describe('recent_changes', () => {
    it('returns the snapshot captured when the incident was declared', async () => {
      const output = await textOf(client, 'recent_changes', { incident: 'INC-2026-0001' });
      expect(output).toContain('7 change(s) captured when INC-2026-0001 was declared');
      expect(output).toContain('#482 Move checkout session storage');
      expect(output).toContain('env=production');
    });

    it('is unaffected by changes that land after the incident', async () => {
      github.setChanges([]);
      const output = await textOf(client, 'recent_changes', { incident: 'INC-2026-0001' });
      expect(output).toContain('7 change(s)');
    });

    it('queries GitHub live when given a window instead of an incident', async () => {
      const output = await textOf(client, 'recent_changes', {
        since: DECLARED_AT.toISOString(),
        until: new Date(DECLARED_AT.getTime() + 3_600_000).toISOString(),
      });
      expect(output).toContain('acme/storefront');
    });

    it('says so plainly when an incident captured nothing', async () => {
      const output = await textOf(client, 'recent_changes', { incident: 'INC-2026-0002' });
      expect(output).toContain('No changes were recorded for INC-2026-0002');
    });

    it('explains an empty live window', async () => {
      github.setChanges([]);
      const output = await textOf(client, 'recent_changes', { hours: 1 });
      expect(output).toContain('Nothing merged or deployed to acme/storefront');
    });
  });

  it('rejects an out-of-range argument at the schema boundary', async () => {
    const result = await client.callTool({ name: 'recent_changes', arguments: { hours: 10_000 } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('hours');
  });
});

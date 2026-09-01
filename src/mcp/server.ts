#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadMcpConfig } from '../config/index.js';
import { GitHubClient } from '../github/client.js';
import { NullGitHub } from '../github/nullClient.js';
import { SqliteIncidentStore } from '../store/sqliteStore.js';
import { registerIncidentTools } from './tools.js';
import { logger } from '../util/logger.js';

/**
 * Read-only MCP server over the incident record.
 *
 * The point is to make an incident history queryable from wherever you already
 * work — "what shipped before the Tuesday outage?" answered from your editor,
 * without opening Slack and scrolling. It never writes, so pointing an agent at
 * it cannot mutate an incident.
 *
 * Transport is stdio, so every log line must go to stderr. `logger` is
 * configured that way; do not add a bare console.log to this file.
 */
async function main(): Promise<void> {
  const config = loadMcpConfig();
  const store = new SqliteIncidentStore(config.databasePath);
  const github = config.github ? new GitHubClient(config.github) : new NullGitHub();

  const server = new McpServer(
    { name: 'firebreak', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Firebreak exposes an engineering team\'s incident record: declared incidents, the timeline responders typed during each one, and the merges and deploys that shipped beforehand. Use list_incidents to locate an incident by date, status, or text, then get_timeline for what happened and recent_changes for what shipped. All tools are read-only.',
    },
  );

  registerIncidentTools(server, { store, github, z });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info({ db: config.databasePath }, 'Firebreak MCP server ready on stdio');

  const shutdown = () => {
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'MCP server failed to start');
  process.exit(1);
});

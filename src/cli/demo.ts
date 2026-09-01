/**
 * End-to-end demo with no credentials required.
 *
 * Runs a complete incident — declare, investigate, note, resolve — against
 * in-process fakes for Slack and GitHub, printing what would have been posted
 * to the channel. The store is a real SQLite database on disk, so afterwards
 * you can point the MCP server at it and query the incident for real.
 *
 *   npm run demo              deterministic heuristics, fully offline
 *   npm run demo -- --live    uses ANTHROPIC_API_KEY for the real agent loop
 */
import { rmSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { IncidentService } from '../core/incidentService.js';
import type { LlmPort } from '../core/ports.js';
import { AnthropicLlm } from '../llm/anthropic.js';
import { HeuristicLlm } from '../llm/heuristic.js';
import { SqliteIncidentStore } from '../store/sqliteStore.js';
import { FakeChat, FakeGitHub } from '../testing/fakes.js';
import { DEMO_INCIDENT_TITLE, DEMO_NOTES, storefrontChanges } from '../testing/fixtures.js';
import { logger } from '../util/logger.js';
import { formatStamp } from '../util/time.js';
import { seedHistory } from './history.js';
import { banner, renderBlocks, slackFrame, style } from './render.js';

loadDotenv({ quiet: true });

interface Args {
  live: boolean;
  keep: boolean;
  dbPath: string;
}

function parseArgs(argv: string[]): Args {
  const dbIndex = argv.indexOf('--db');
  return {
    live: argv.includes('--live'),
    keep: argv.includes('--keep'),
    dbPath: dbIndex >= 0 ? (argv[dbIndex + 1] ?? './data/demo.db') : './data/demo.db',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // The demo's output is the point; service logs would drown it.
  logger.level = process.env.LOG_LEVEL ?? 'warn';

  if (!args.keep) {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${args.dbPath}${suffix}`, { force: true });
    }
  }

  const llm = pickLlm(args.live);
  const store = new SqliteIncidentStore(args.dbPath);

  process.stdout.write(banner('Firebreak demo'));
  process.stdout.write(
    [
      `${style.dim('engine    ')} ${llm.model}${llm.model === 'heuristic-v1' ? style.dim('  (run with --live and ANTHROPIC_API_KEY for the agent loop)') : ''}`,
      `${style.dim('database  ')} ${args.dbPath}`,
      `${style.dim('slack     ')} in-process fake — nothing leaves this machine`,
      `${style.dim('github    ')} in-process fake — fixture repo acme/storefront`,
      '',
    ].join('\n'),
  );

  process.stdout.write(banner('Seeding incident history'));
  const historyKeys = await seedHistory(store, llm);
  process.stdout.write(`  ${historyKeys.join(', ')} written to the incident record.\n`);

  // --- the featured incident ------------------------------------------------

  const declaredAt = new Date();
  const chat = new FakeChat();
  const github = new FakeGitHub(storefrontChanges(declaredAt));
  const printed = { count: 0 };

  // The demo runs in milliseconds but should read like an incident that took
  // most of an hour, so the clock walks forward four minutes per event.
  let cursor = declaredAt.getTime();
  const clock = () => new Date((cursor += 4 * 60_000) - 4 * 60_000);

  const service = new IncidentService(
    { store, github, chat, llm },
    { lookbackHours: 48, lookbackLimit: 30, announceChannel: 'C_INCIDENTS', clock },
  );

  const responder = { id: 'U0RHEE', name: 'rhee' };

  process.stdout.write(banner('/incident declare sev2 ' + DEMO_INCIDENT_TITLE));
  const declared = await service.declare({
    title: DEMO_INCIDENT_TITLE,
    severity: 'sev2',
    actor: responder,
  });
  flush(chat, printed);

  process.stdout.write(banner('Correlating recent changes'));
  process.stdout.write(
    `  ${style.dim('Pulling merges and deploys from the last 48h, then asking the agent which could be related...')}\n`,
  );
  const report = await declared.investigate();
  flush(chat, printed);
  process.stdout.write(
    `\n  ${style.dim(`agent made ${report.toolCalls} tool call(s); inspected: ${github.detailRequests.length > 0 ? [...new Set(github.detailRequests)].join(', ') : 'nothing'}`)}\n`,
  );

  const channelId = declared.channel!.id;

  process.stdout.write(banner('Responders working the incident'));
  for (const [index, note] of DEMO_NOTES.entries()) {
    if (index === 3) {
      await service.setStatus({ ref: { channelId }, status: 'identified', actor: responder });
      process.stdout.write(`  ${style.yellow('status ->')} identified\n`);
    }
    if (index === 6) {
      await service.setStatus({ ref: { channelId }, status: 'monitoring', actor: responder });
      process.stdout.write(`  ${style.yellow('status ->')} monitoring\n`);
    }
    const entry = await service.addNote({ ref: { channelId }, text: note, actor: responder });
    process.stdout.write(`  ${style.dim(formatStamp(entry.at))}  ${style.cyan(entry.authorName)}: ${note}\n`);
  }

  process.stdout.write(banner('/incident resolve'));
  const resolved = await service.resolve({ ref: { channelId }, actor: responder });
  flush(chat, printed);

  process.stdout.write(banner(`Postmortem opened as ${resolved.issue?.url ?? '(issue creation failed)'}`));
  process.stdout.write(indent(resolved.postmortem.markdown));

  process.stdout.write(banner('Now query it from Claude Code'));
  process.stdout.write(
    [
      `  The whole incident is in ${style.bold(args.dbPath)}. Point the MCP server at it:`,
      '',
      `    ${style.green(`claude mcp add firebreak -e DATABASE_PATH=${args.dbPath} -- npx tsx src/mcp/server.ts`)}`,
      '',
      '  Then ask, in Claude Code:',
      `    ${style.dim('"what shipped before the checkout incident?"')}`,
      `    ${style.dim('"show me the timeline for ' + resolved.incident.key + '"')}`,
      `    ${style.dim('"which incidents did we have in the last week?"')}`,
      '',
    ].join('\n'),
  );

  store.close();
}

/** Prints every Slack message posted since the last flush. */
function flush(chat: FakeChat, printed: { count: number }): void {
  const names = new Map(chat.channels.map((c) => [c.id, c.name]));
  names.set('C_INCIDENTS', 'incidents');
  for (const post of chat.posts.slice(printed.count)) {
    const channel = names.get(post.channelId) ?? post.channelId;
    process.stdout.write(`${slackFrame(channel, renderBlocks(post.blocks, post.text, names))}\n\n`);
  }
  printed.count = chat.posts.length;
}

function pickLlm(live: boolean): LlmPort {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!live) return new HeuristicLlm();
  if (!apiKey) {
    process.stderr.write('--live was passed but ANTHROPIC_API_KEY is not set; falling back to heuristics.\n');
    return new HeuristicLlm();
  }
  return new AnthropicLlm({ apiKey, model: process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-5' });
}

function indent(text: string): string {
  return `${text
    .split('\n')
    .map((line) => `  ${style.dim('|')} ${line}`)
    .join('\n')}\n`;
}

main().catch((err) => {
  process.stderr.write(`\n${style.red('demo failed:')} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});

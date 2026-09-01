import { App, LogLevel } from '@slack/bolt';
import type { IncidentService } from '../core/incidentService.js';
import type { Actor } from '../core/types.js';
import { messageFor } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { helpBlocks, listBlocks } from './blocks.js';
import { parseCommand } from './parseCommand.js';
import { formatStamp } from '../util/time.js';

export interface SlackAppOptions {
  botToken: string;
  appToken: string;
  signingSecret: string;
  service: IncidentService;
  port: number;
}

export function createSlackApp(opts: SlackAppOptions): App {
  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    signingSecret: opts.signingSecret,
    socketMode: true,
    logLevel: process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.WARN,
  });

  const names = new DisplayNameCache();

  app.command('/incident', async ({ command, ack, respond, client }) => {
    // Slack drops the interaction after 3 seconds. Acknowledge first, always.
    await ack();

    const started = Date.now();
    let subcommand = 'unknown';
    try {
      const parsed = parseCommand(command.text ?? '');
      subcommand = parsed.kind;
      const actor: Actor = {
        id: command.user_id,
        name: await names.get(client, command.user_id, command.user_name),
      };
      const channelId = command.channel_id;

      switch (parsed.kind) {
        case 'help':
          await respond({ response_type: 'ephemeral', blocks: helpBlocks() as never, text: 'Firebreak commands' });
          break;

        case 'declare': {
          const result = await opts.service.declare({
            title: parsed.title,
            severity: parsed.severity,
            actor,
          });
          await respond({
            response_type: 'ephemeral',
            text: result.channel
              ? `${result.incident.key} declared → <#${result.channel.id}>. Pulling recent changes now.`
              : `${result.incident.key} declared, but the channel could not be opened. Use \`/incident note ${result.incident.key} …\` to log.`,
          });

          // Deliberately not awaited: GitHub plus the correlation agent take
          // several seconds, and the responder should not be staring at Slack
          // for them. The result is posted into the incident channel.
          void result
            .investigate()
            .catch((err) => logger.error({ err, key: result.incident.key }, 'investigation failed'));
          break;
        }

        case 'note': {
          const entry = await opts.service.addNote({
            ref: { key: parsed.key, channelId },
            text: parsed.text,
            actor,
          });
          await respond({ response_type: 'ephemeral', text: `Logged at ${formatStamp(entry.at)}.` });
          break;
        }

        case 'status': {
          const incident = await opts.service.setStatus({
            ref: { key: parsed.key, channelId },
            status: parsed.status,
            actor,
          });
          await respond({ response_type: 'ephemeral', text: `${incident.key} is now *${incident.status}*.` });
          break;
        }

        case 'resolve': {
          await respond({ response_type: 'ephemeral', text: 'Resolving and drafting the postmortem…' });
          const result = await opts.service.resolve({ ref: { key: parsed.key, channelId }, actor });
          await respond({
            response_type: 'ephemeral',
            text: result.issue
              ? `${result.incident.key} resolved. Postmortem draft: ${result.issue.url}`
              : `${result.incident.key} resolved. The postmortem draft is stored, but GitHub rejected the issue — check the logs.`,
          });
          break;
        }

        case 'show': {
          const snapshot = await opts.service.snapshot(parsed.key ?? (await keyForChannel(opts.service, channelId)));
          await respond({ response_type: 'ephemeral', text: renderSnapshot(snapshot) });
          break;
        }

        case 'list': {
          const incidents = await opts.service.list(
            parsed.scope === 'open' ? { status: 'investigating', limit: 20 } : { limit: 20 },
          );
          await respond({ response_type: 'ephemeral', blocks: listBlocks(incidents) as never, text: 'Incidents' });
          break;
        }
      }

      logger.info({ subcommand, user: command.user_id, ms: Date.now() - started }, 'command handled');
    } catch (err) {
      logger.error({ err, subcommand, text: command.text }, 'command failed');
      await respond({ response_type: 'ephemeral', text: `:warning: ${messageFor(err)}` }).catch(() => {});
    }
  });

  app.error(async (err) => {
    logger.error({ err }, 'unhandled Bolt error');
  });

  return app;
}

async function keyForChannel(service: IncidentService, channelId: string): Promise<string> {
  const open = await service.list({ limit: 100 });
  const match = open.find((i) => i.channelId === channelId);
  return match?.key ?? channelId;
}

function renderSnapshot(snapshot: {
  incident: { key: string; title: string; status: string; severity: string };
  timeline: { at: string; authorName: string; text: string }[];
}): string {
  const header = `*${snapshot.incident.key}* — ${snapshot.incident.title} (${snapshot.incident.severity.toUpperCase()}, ${snapshot.incident.status})`;
  const body = snapshot.timeline.length
    ? snapshot.timeline.map((e) => `• ${formatStamp(e.at)} — ${e.authorName}: ${e.text}`).join('\n')
    : '_No timeline entries yet._';
  return `${header}\n\n${body}`;
}

/** users.info is rate-limited per workspace; a name never changes mid-incident. */
class DisplayNameCache {
  private readonly cache = new Map<string, string>();

  async get(client: { users: { info: (args: { user: string }) => Promise<unknown> } }, userId: string, fallback: string): Promise<string> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    try {
      const info = (await client.users.info({ user: userId })) as {
        user?: { profile?: { display_name?: string; real_name?: string } };
      };
      const name = info.user?.profile?.display_name || info.user?.profile?.real_name || fallback;
      this.cache.set(userId, name);
      return name;
    } catch {
      return fallback;
    }
  }
}

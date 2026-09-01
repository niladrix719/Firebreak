import { WebClient } from '@slack/web-api';
import type { AppConfig } from './config/index.js';
import { IncidentService } from './core/incidentService.js';
import type { GitHubPort, IncidentStore, LlmPort } from './core/ports.js';
import { GitHubClient } from './github/client.js';
import { NullGitHub } from './github/nullClient.js';
import { AnthropicLlm } from './llm/anthropic.js';
import { HeuristicLlm } from './llm/heuristic.js';
import { SlackChatAdapter } from './slack/chatAdapter.js';
import { SqliteIncidentStore } from './store/sqliteStore.js';
import { logger } from './util/logger.js';

export interface Wiring {
  store: IncidentStore;
  github: GitHubPort;
  llm: LlmPort;
  service: IncidentService;
  close(): void;
}

/**
 * The composition root. Every `new` for a production adapter happens here and
 * nowhere else, which is what lets `test/` and `src/cli/demo.ts` swap in fakes
 * without touching a line of the core.
 */
export function buildWiring(config: AppConfig): Wiring {
  const store = new SqliteIncidentStore(config.databasePath);

  const github: GitHubPort = config.github
    ? new GitHubClient(config.github)
    : (logger.warn('GITHUB_* not set — change correlation and postmortem issues are disabled'), new NullGitHub());

  const llm: LlmPort = config.anthropic
    ? new AnthropicLlm({ apiKey: config.anthropic.apiKey, model: config.anthropic.model })
    : (logger.warn('ANTHROPIC_API_KEY not set — falling back to deterministic heuristics'), new HeuristicLlm());

  const chat = new SlackChatAdapter(new WebClient(config.slack.botToken));

  const service = new IncidentService(
    { store, github, chat, llm },
    {
      lookbackHours: config.lookbackHours,
      lookbackLimit: config.lookbackLimit,
      announceChannel: config.slack.announceChannel,
    },
  );

  return { store, github, llm, service, close: () => store.close() };
}

import { loadConfig } from './config/index.js';
import { buildWiring } from './composition.js';
import { createSlackApp } from './slack/app.js';
import { logger } from './util/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const wiring = buildWiring(config);

  const app = createSlackApp({
    botToken: config.slack.botToken,
    appToken: config.slack.appToken,
    signingSecret: config.slack.signingSecret,
    service: wiring.service,
    port: config.port,
  });

  await app.start();
  logger.info(
    {
      db: config.databasePath,
      repo: config.github ? `${config.github.owner}/${config.github.repo}` : 'not configured',
      model: config.anthropic?.model ?? 'heuristic-v1',
      lookbackHours: config.lookbackHours,
    },
    'Firebreak is listening on Socket Mode — try /incident help',
  );

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    void app
      .stop()
      .catch((err) => logger.error({ err }, 'error stopping the Slack app'))
      .finally(() => {
        wiring.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

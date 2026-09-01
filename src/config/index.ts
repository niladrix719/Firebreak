import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv({ quiet: true });

const trimmed = z.string().trim().min(1);

const slackSchema = z.object({
  botToken: trimmed,
  signingSecret: trimmed,
  appToken: trimmed,
  announceChannel: z.string().trim().min(1).optional(),
});

const githubSchema = z.object({
  token: trimmed,
  owner: trimmed,
  repo: trimmed,
  apiUrl: z.url().optional(),
});

const anthropicSchema = z.object({
  apiKey: trimmed,
  model: z.string().trim().min(1).default('claude-sonnet-5'),
});

const runtimeSchema = z.object({
  databasePath: z.string().trim().min(1).default('./data/firebreak.db'),
  port: z.coerce.number().int().positive().max(65535).default(3000),
  lookbackHours: z.coerce.number().positive().max(24 * 30).default(48),
  lookbackLimit: z.coerce.number().int().positive().max(200).default(30),
});

export interface AppConfig extends z.infer<typeof runtimeSchema> {
  slack: z.infer<typeof slackSchema>;
  /** Absent when GitHub is not configured — the bot still runs, without change correlation. */
  github: z.infer<typeof githubSchema> | null;
  /** Absent when there is no API key — the bot falls back to deterministic heuristics. */
  anthropic: z.infer<typeof anthropicSchema> | null;
}

const ENV_NAMES: Record<string, string> = {
  botToken: 'SLACK_BOT_TOKEN',
  signingSecret: 'SLACK_SIGNING_SECRET',
  appToken: 'SLACK_APP_TOKEN',
  announceChannel: 'SLACK_ANNOUNCE_CHANNEL',
  token: 'GITHUB_TOKEN',
  owner: 'GITHUB_OWNER',
  repo: 'GITHUB_REPO',
  apiUrl: 'GITHUB_API_URL',
  apiKey: 'ANTHROPIC_API_KEY',
  model: 'ANTHROPIC_MODEL',
  databasePath: 'DATABASE_PATH',
  port: 'PORT',
  lookbackHours: 'CHANGE_LOOKBACK_HOURS',
  lookbackLimit: 'CHANGE_LOOKBACK_LIMIT',
};

const clean = (value: string | undefined): string | undefined => {
  const trimmedValue = value?.trim();
  return trimmedValue === '' ? undefined : trimmedValue;
};

/**
 * Validates the environment once, at boot.
 *
 * Slack is required — it is the entire interface. GitHub and Anthropic are
 * optional groups: configure all of a group or none of it. A half-configured
 * group is a typo, not an intent, so it fails loudly.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const problems: string[] = [];

  const slack = slackSchema.safeParse({
    botToken: clean(env.SLACK_BOT_TOKEN),
    signingSecret: clean(env.SLACK_SIGNING_SECRET),
    appToken: clean(env.SLACK_APP_TOKEN),
    announceChannel: clean(env.SLACK_ANNOUNCE_CHANNEL),
  });
  if (!slack.success) problems.push(...describe(slack.error));

  const githubVars = {
    token: clean(env.GITHUB_TOKEN),
    owner: clean(env.GITHUB_OWNER),
    repo: clean(env.GITHUB_REPO),
    apiUrl: clean(env.GITHUB_API_URL),
  };
  const github = resolveOptionalGroup('GitHub', githubSchema, githubVars, ['token', 'owner', 'repo'], problems);

  const anthropicVars = { apiKey: clean(env.ANTHROPIC_API_KEY), model: clean(env.ANTHROPIC_MODEL) };
  const anthropic = resolveOptionalGroup('Anthropic', anthropicSchema, anthropicVars, ['apiKey'], problems);

  const runtime = runtimeSchema.safeParse({
    databasePath: clean(env.DATABASE_PATH),
    port: clean(env.PORT),
    lookbackHours: clean(env.CHANGE_LOOKBACK_HOURS),
    lookbackLimit: clean(env.CHANGE_LOOKBACK_LIMIT),
  });
  if (!runtime.success) problems.push(...describe(runtime.error));

  if (problems.length > 0) {
    throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\nSee .env.example.`);
  }

  return { ...runtime.data!, slack: slack.data!, github, anthropic };
}

function resolveOptionalGroup<T extends z.ZodType>(
  label: string,
  schema: T,
  values: Record<string, string | undefined>,
  required: string[],
  problems: string[],
): z.infer<T> | null {
  const present = required.filter((k) => values[k] !== undefined);
  if (present.length === 0) return null;
  if (present.length < required.length) {
    const missing = required.filter((k) => values[k] === undefined).map((k) => ENV_NAMES[k] ?? k);
    problems.push(`${label} is partially configured — also set ${missing.join(', ')} (or unset the group entirely)`);
    return null;
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    problems.push(...describe(parsed.error));
    return null;
  }
  return parsed.data;
}

function describe(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const leaf = String(issue.path.at(-1) ?? '');
    return `${ENV_NAMES[leaf] ?? (leaf || 'config')}: ${humanize(issue)}`;
  });
}

/** Zod's default for a missing variable reads like a type error, not a setup step. */
function humanize(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_type' && issue.input === undefined) return 'not set';
  return issue.message;
}

/** The MCP server reads incidents from disk and needs no credentials of its own. */
export function loadMcpConfig(env: NodeJS.ProcessEnv = process.env): {
  databasePath: string;
  github: z.infer<typeof githubSchema> | null;
} {
  const problems: string[] = [];
  const github = resolveOptionalGroup(
    'GitHub',
    githubSchema,
    {
      token: clean(env.GITHUB_TOKEN),
      owner: clean(env.GITHUB_OWNER),
      repo: clean(env.GITHUB_REPO),
      apiUrl: clean(env.GITHUB_API_URL),
    },
    ['token', 'owner', 'repo'],
    problems,
  );
  return { databasePath: clean(env.DATABASE_PATH) ?? './data/firebreak.db', github };
}

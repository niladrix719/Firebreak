import { describe, expect, it } from 'vitest';
import { loadConfig, loadMcpConfig } from '../src/config/index.js';

const SLACK = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'secret',
  SLACK_APP_TOKEN: 'xapp-test',
};

const GITHUB = {
  GITHUB_TOKEN: 'ghp-test',
  GITHUB_OWNER: 'acme',
  GITHUB_REPO: 'storefront',
};

describe('loadConfig', () => {
  it('accepts a Slack-only configuration and applies defaults', () => {
    const config = loadConfig({ ...SLACK } as NodeJS.ProcessEnv);

    expect(config.slack.botToken).toBe('xoxb-test');
    expect(config.github).toBeNull();
    expect(config.anthropic).toBeNull();
    expect(config.databasePath).toBe('./data/firebreak.db');
    expect(config.port).toBe(3000);
    expect(config.lookbackHours).toBe(48);
    expect(config.lookbackLimit).toBe(30);
  });

  it('lists every missing Slack variable at once', () => {
    let message = '';
    try {
      loadConfig({} as NodeJS.ProcessEnv);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('SLACK_BOT_TOKEN');
    expect(message).toContain('SLACK_SIGNING_SECRET');
    expect(message).toContain('SLACK_APP_TOKEN');
    expect(message).toContain('.env.example');
  });

  it('treats whitespace-only values as absent', () => {
    expect(() => loadConfig({ ...SLACK, SLACK_BOT_TOKEN: '   ' } as NodeJS.ProcessEnv)).toThrow(/SLACK_BOT_TOKEN/);
  });

  it('accepts a complete GitHub group', () => {
    const config = loadConfig({ ...SLACK, ...GITHUB } as NodeJS.ProcessEnv);
    expect(config.github).toEqual({ token: 'ghp-test', owner: 'acme', repo: 'storefront', apiUrl: undefined });
  });

  it('rejects a half-configured GitHub group as a typo', () => {
    expect(() => loadConfig({ ...SLACK, GITHUB_TOKEN: 'ghp-test' } as NodeJS.ProcessEnv)).toThrow(
      /GitHub is partially configured — also set GITHUB_OWNER, GITHUB_REPO/,
    );
  });

  it('rejects an invalid GitHub Enterprise URL', () => {
    expect(() =>
      loadConfig({ ...SLACK, ...GITHUB, GITHUB_API_URL: 'not-a-url' } as NodeJS.ProcessEnv),
    ).toThrow(/GITHUB_API_URL/);
  });

  it('defaults the Anthropic model when only a key is set', () => {
    const config = loadConfig({ ...SLACK, ANTHROPIC_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
    expect(config.anthropic).toEqual({ apiKey: 'sk-test', model: 'claude-sonnet-5' });
  });

  it('honours an explicit model', () => {
    const config = loadConfig({
      ...SLACK,
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_MODEL: 'claude-opus-5',
    } as NodeJS.ProcessEnv);
    expect(config.anthropic?.model).toBe('claude-opus-5');
  });

  it('coerces and validates numeric settings', () => {
    const config = loadConfig({
      ...SLACK,
      PORT: '8080',
      CHANGE_LOOKBACK_HOURS: '12',
      CHANGE_LOOKBACK_LIMIT: '5',
    } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ port: 8080, lookbackHours: 12, lookbackLimit: 5 });
  });

  it('rejects a nonsensical lookback window', () => {
    expect(() => loadConfig({ ...SLACK, CHANGE_LOOKBACK_HOURS: '-1' } as NodeJS.ProcessEnv)).toThrow(
      /CHANGE_LOOKBACK_HOURS/,
    );
    expect(() => loadConfig({ ...SLACK, CHANGE_LOOKBACK_HOURS: '99999' } as NodeJS.ProcessEnv)).toThrow(
      /CHANGE_LOOKBACK_HOURS/,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadConfig({ ...SLACK, PORT: '70000' } as NodeJS.ProcessEnv)).toThrow(/PORT/);
  });

  it('reports several problems in one error', () => {
    let message = '';
    try {
      loadConfig({ SLACK_BOT_TOKEN: 'x', GITHUB_TOKEN: 'y', PORT: 'abc' } as NodeJS.ProcessEnv);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('SLACK_SIGNING_SECRET');
    expect(message).toContain('GitHub is partially configured');
    expect(message).toContain('PORT');
  });
});

describe('loadMcpConfig', () => {
  it('needs no credentials at all', () => {
    expect(loadMcpConfig({} as NodeJS.ProcessEnv)).toEqual({
      databasePath: './data/firebreak.db',
      github: null,
    });
  });

  it('picks up GitHub when it is configured, for live change queries', () => {
    const config = loadMcpConfig({ ...GITHUB, DATABASE_PATH: './data/staging.db' } as NodeJS.ProcessEnv);
    expect(config.databasePath).toBe('./data/staging.db');
    expect(config.github).toMatchObject({ owner: 'acme', repo: 'storefront' });
  });
});

import type { ChangeWindow, GitHubPort } from '../core/ports.js';
import type { ChangeDetail, ChangeEvent } from '../core/types.js';
import { UpstreamError } from '../util/errors.js';
import { logger } from '../util/logger.js';

/**
 * Stands in when GitHub is not configured. Declaring still works — you get a
 * channel, a template, and a timeline — you just don't get change correlation.
 * Better than refusing to boot over a missing optional integration.
 */
export class NullGitHub implements GitHubPort {
  async listRecentChanges(_window: ChangeWindow): Promise<ChangeEvent[]> {
    logger.debug('GitHub is not configured; skipping change lookup');
    return [];
  }

  async getChangeDetail(_changeId: string): Promise<ChangeDetail | null> {
    return null;
  }

  async createIssue(): Promise<{ number: number; url: string }> {
    throw new UpstreamError('github', 'GitHub is not configured, so the postmortem issue was not opened');
  }

  repoSlug(): string {
    return '(github not configured)';
  }
}

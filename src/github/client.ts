import { Octokit } from '@octokit/rest';
import type { ChangeWindow, GitHubPort } from '../core/ports.js';
import type { ChangeDetail, ChangeEvent } from '../core/types.js';
import { UpstreamError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { mapWithConcurrency, withRetry } from '../util/retry.js';

export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
  apiUrl?: string;
}

/** Deployment states we consider to have actually shipped code. */
const SHIPPED_STATES = new Set(['success', 'in_progress', 'queued']);

export class GitHubClient implements GitHubPort {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;

  constructor(opts: GitHubClientOptions) {
    this.octokit = new Octokit({
      auth: opts.token,
      baseUrl: opts.apiUrl,
      userAgent: 'firebreak/1.0',
    });
    this.owner = opts.owner;
    this.repo = opts.repo;
  }

  repoSlug(): string {
    return `${this.owner}/${this.repo}`;
  }

  /**
   * Merged PRs and successful deployments in the window, newest first.
   *
   * We list closed PRs sorted by update time rather than hitting the search
   * API: search is rate-limited at 30 req/min, and an incident is exactly when
   * you don't want to be throttled.
   */
  async listRecentChanges(window: ChangeWindow): Promise<ChangeEvent[]> {
    const [merges, deploys] = await Promise.all([
      this.listMerges(window).catch((err) => {
        logger.error({ err }, 'failed to list merged pull requests');
        return [] as ChangeEvent[];
      }),
      this.listDeploys(window).catch((err) => {
        logger.error({ err }, 'failed to list deployments');
        return [] as ChangeEvent[];
      }),
    ]);

    return [...merges, ...deploys]
      .filter((c) => new Date(c.at) >= window.since && (!window.until || new Date(c.at) <= window.until))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, window.limit);
  }

  private async listMerges(window: ChangeWindow): Promise<ChangeEvent[]> {
    const pages = await withRetry(
      () =>
        this.octokit.paginate(this.octokit.pulls.list, {
          owner: this.owner,
          repo: this.repo,
          state: 'closed',
          sort: 'updated',
          direction: 'desc',
          per_page: 100,
        }, (response, done) => {
          // Sorted by update time, so once a page ends before the window we can stop.
          const last = response.data.at(-1);
          if (last?.updated_at && new Date(last.updated_at) < window.since) done();
          return response.data;
        }),
      { label: 'github.pulls.list' },
    );

    return pages
      .filter((pr) => pr.merged_at !== null)
      .map((pr) => ({
        id: `pr:${pr.number}`,
        kind: 'merge' as const,
        title: `#${pr.number} ${pr.title}`,
        url: pr.html_url,
        author: pr.user?.login ?? 'unknown',
        at: pr.merged_at!,
        sha: pr.merge_commit_sha ?? null,
        prNumber: pr.number,
        environment: null,
      }));
  }

  private async listDeploys(window: ChangeWindow): Promise<ChangeEvent[]> {
    const deployments = await withRetry(
      () =>
        this.octokit.repos.listDeployments({
          owner: this.owner,
          repo: this.repo,
          per_page: 100,
        }),
      { label: 'github.repos.listDeployments' },
    );

    const candidates = deployments.data
      .filter((d) => new Date(d.created_at) >= window.since)
      .slice(0, window.limit);

    const withStates = await mapWithConcurrency(candidates, 5, async (d) => {
      const state = await this.latestDeploymentState(d.id);
      return { deployment: d, state };
    });

    return withStates
      .filter(({ state }) => state === null || SHIPPED_STATES.has(state))
      .map(({ deployment: d, state }) => ({
        id: `deploy:${d.id}`,
        kind: 'deploy' as const,
        title: `Deploy to ${d.environment}${state ? ` (${state})` : ''} — ${d.ref}`,
        url: `https://github.com/${this.owner}/${this.repo}/deployments`,
        author: d.creator?.login ?? 'unknown',
        at: d.created_at,
        sha: d.sha,
        prNumber: null,
        environment: d.environment,
      }));
  }

  private async latestDeploymentState(deploymentId: number): Promise<string | null> {
    try {
      const statuses = await this.octokit.repos.listDeploymentStatuses({
        owner: this.owner,
        repo: this.repo,
        deployment_id: deploymentId,
        per_page: 1,
      });
      return statuses.data[0]?.state ?? null;
    } catch (err) {
      logger.debug({ err, deploymentId }, 'could not read deployment status; treating as shipped');
      return null;
    }
  }

  /** Diff stat + body for one change. `pr:N`, `deploy:N` and `commit:<sha>` are all accepted. */
  async getChangeDetail(changeId: string): Promise<ChangeDetail | null> {
    const [kind, value] = splitChangeId(changeId);
    try {
      if (kind === 'pr') return await this.pullRequestDetail(Number(value));
      if (kind === 'commit') return await this.commitDetail(value);
      if (kind === 'deploy') {
        const deployment = await this.octokit.repos.getDeployment({
          owner: this.owner,
          repo: this.repo,
          deployment_id: Number(value),
        });
        return await this.commitDetail(deployment.data.sha);
      }
      return null;
    } catch (err) {
      logger.warn({ err, changeId }, 'change detail lookup failed');
      return null;
    }
  }

  private async pullRequestDetail(number: number): Promise<ChangeDetail> {
    const [pr, files] = await Promise.all([
      withRetry(() => this.octokit.pulls.get({ owner: this.owner, repo: this.repo, pull_number: number }), {
        label: 'github.pulls.get',
      }),
      withRetry(
        () =>
          this.octokit.pulls.listFiles({
            owner: this.owner,
            repo: this.repo,
            pull_number: number,
            per_page: 100,
          }),
        { label: 'github.pulls.listFiles' },
      ),
    ]);

    const body = pr.data.body ?? null;
    return {
      body: truncate(body, 4000),
      filesChanged: files.data.map((f) => f.filename),
      additions: pr.data.additions ?? 0,
      deletions: pr.data.deletions ?? 0,
      isRevert: looksLikeRevert(pr.data.title, body),
    };
  }

  private async commitDetail(sha: string): Promise<ChangeDetail> {
    const commit = await withRetry(
      () => this.octokit.repos.getCommit({ owner: this.owner, repo: this.repo, ref: sha }),
      { label: 'github.repos.getCommit' },
    );
    const message = commit.data.commit.message;
    return {
      body: truncate(message, 4000),
      filesChanged: (commit.data.files ?? []).map((f) => f.filename),
      additions: commit.data.stats?.additions ?? 0,
      deletions: commit.data.stats?.deletions ?? 0,
      isRevert: looksLikeRevert(message, null),
    };
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
    try {
      const issue = await withRetry(
        () =>
          this.octokit.issues.create({
            owner: this.owner,
            repo: this.repo,
            title: input.title,
            body: input.body,
            labels: input.labels,
          }),
        { label: 'github.issues.create' },
      );
      return { number: issue.data.number, url: issue.data.html_url };
    } catch (err) {
      throw new UpstreamError('github', 'could not open the postmortem issue', err);
    }
  }
}

export function splitChangeId(changeId: string): [string, string] {
  const index = changeId.indexOf(':');
  if (index === -1) return ['', changeId];
  return [changeId.slice(0, index), changeId.slice(index + 1)];
}

export function looksLikeRevert(title: string, body: string | null): boolean {
  return /\b(revert|rollback|roll back|hotfix)\b/i.test(`${title}\n${body ?? ''}`);
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length <= max ? value : `${value.slice(0, max)}\n…[truncated]`;
}

import type { ChangeWindow, ChatChannel, ChatPort, GitHubPort } from '../core/ports.js';
import type { ChangeDetail, ChangeEvent } from '../core/types.js';
import { UpstreamError } from '../util/errors.js';
import type { FixtureChange } from './fixtures.js';

export interface PostedMessage {
  channelId: string;
  text: string;
  blocks: unknown[] | undefined;
}

/**
 * Ids must be unique across instances: the store has a unique index on
 * channel_id, and a demo that seeds several incidents builds a fresh fake for
 * each one.
 */
let channelCounter = 0;
let issueCounter = 900;

/** Records everything that would have been sent to Slack. */
export class FakeChat implements ChatPort {
  readonly channels: ChatChannel[] = [];
  readonly posts: PostedMessage[] = [];
  readonly invites: { channelId: string; userIds: string[] }[] = [];
  readonly bookmarks: { channelId: string; title: string; url: string }[] = [];
  /** Set to make channel creation fail, exercising the degraded path. */
  failCreate = false;

  async createChannel(name: string, _topic: string): Promise<ChatChannel> {
    if (this.failCreate) throw new UpstreamError('slack', 'simulated channel creation failure');
    const channel = { id: `C${String(++channelCounter).padStart(9, '0')}`, name };
    this.channels.push(channel);
    return channel;
  }

  async invite(channelId: string, userIds: string[]): Promise<void> {
    this.invites.push({ channelId, userIds });
  }

  async post(channelId: string, text: string, blocks?: unknown[]): Promise<{ ts: string }> {
    this.posts.push({ channelId, text, blocks });
    return { ts: `${Date.now()}.${this.posts.length}` };
  }

  async setBookmark(channelId: string, title: string, url: string): Promise<void> {
    this.bookmarks.push({ channelId, title, url });
  }

  postsFor(channelId: string): PostedMessage[] {
    return this.posts.filter((p) => p.channelId === channelId);
  }
}

/** Serves fixture changes and records which details the correlator asked for. */
export class FakeGitHub implements GitHubPort {
  readonly detailRequests: string[] = [];
  readonly issues: { title: string; body: string; labels: string[] }[] = [];
  /** Set to make every call throw, exercising the degraded path. */
  failing = false;

  constructor(private changes: FixtureChange[] = [], private readonly slug = 'acme/storefront') {}

  setChanges(changes: FixtureChange[]): void {
    this.changes = changes;
  }

  async listRecentChanges(window: ChangeWindow): Promise<ChangeEvent[]> {
    if (this.failing) throw new UpstreamError('github', 'simulated GitHub outage');
    return this.changes
      .filter((c) => new Date(c.at) >= window.since && (!window.until || new Date(c.at) <= window.until))
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, window.limit)
      .map(({ detail: _detail, ...rest }) => rest);
  }

  async getChangeDetail(changeId: string): Promise<ChangeDetail | null> {
    this.detailRequests.push(changeId);
    if (this.failing) throw new UpstreamError('github', 'simulated GitHub outage');
    return this.changes.find((c) => c.id === changeId)?.detail ?? null;
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }> {
    if (this.failing) throw new UpstreamError('github', 'simulated GitHub outage');
    this.issues.push(input);
    const number = ++issueCounter;
    return { number, url: `https://github.com/${this.slug}/issues/${number}` };
  }

  repoSlug(): string {
    return this.slug;
  }
}

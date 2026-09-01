import type { WebClient } from '@slack/web-api';
import type { ChatChannel, ChatPort } from '../core/ports.js';
import { UpstreamError } from '../util/errors.js';
import { logger } from '../util/logger.js';
import { withRetry } from '../util/retry.js';

export class SlackChatAdapter implements ChatPort {
  constructor(private readonly client: WebClient) {}

  /**
   * Slack rejects duplicate channel names. During an incident that must not be
   * a hard failure, so we retry with a numeric suffix a few times.
   */
  async createChannel(name: string, topic: string): Promise<ChatChannel> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const candidate = attempt === 0 ? name : `${name.slice(0, 76)}-${attempt + 1}`;
      try {
        const created = await this.client.conversations.create({ name: candidate, is_private: false });
        const channel = created.channel;
        if (!channel?.id) throw new UpstreamError('slack', 'conversations.create returned no channel id');

        await this.client.conversations
          .setTopic({ channel: channel.id, topic: topic.slice(0, 250) })
          .catch((err) => logger.warn({ err }, 'could not set the channel topic'));

        return { id: channel.id, name: channel.name ?? candidate };
      } catch (err) {
        if (slackErrorCode(err) === 'name_taken') continue;
        throw new UpstreamError('slack', `could not create #${candidate}`, err);
      }
    }
    throw new UpstreamError('slack', `every candidate name derived from "${name}" was taken`);
  }

  async invite(channelId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.client.conversations.invite({ channel: channelId, users: userIds.join(',') });
    } catch (err) {
      // Already in the channel is the common case and is not a failure.
      const code = slackErrorCode(err);
      if (code === 'already_in_channel' || code === 'cant_invite_self') return;
      logger.warn({ err, channelId }, 'could not invite responders');
    }
  }

  async post(channelId: string, text: string, blocks?: unknown[]): Promise<{ ts: string }> {
    try {
      const result = await withRetry(
        () =>
          this.client.chat.postMessage({
            channel: channelId,
            text,
            ...(blocks ? { blocks: blocks as never } : {}),
          }),
        { label: 'slack.chat.postMessage' },
      );
      return { ts: String(result.ts) };
    } catch (err) {
      throw new UpstreamError('slack', `could not post to ${channelId}`, err);
    }
  }

  async setBookmark(channelId: string, title: string, url: string): Promise<void> {
    await this.client.bookmarks
      .add({ channel_id: channelId, title, type: 'link', link: url })
      .catch((err) => logger.debug({ err }, 'could not add the channel bookmark'));
  }
}

function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } })?.data?.error;
}

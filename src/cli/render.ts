/** Renders Block Kit payloads as terminal text, for the offline demo. */

const ESC = '[';
const isTty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (text: string) => (isTty ? `${ESC}${code}m${text}${ESC}0m` : text);

export const style = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
};

type Block = Record<string, unknown>;

export function renderBlocks(
  blocks: unknown[] | undefined,
  fallback: string,
  channelNames: Map<string, string> = new Map(),
): string {
  const mrkdwn = (text: string) => renderMrkdwn(text, channelNames);
  if (!blocks || blocks.length === 0) return mrkdwn(fallback);

  const lines: string[] = [];
  for (const raw of blocks as Block[]) {
    const textNode = raw.text as { text?: string } | undefined;
    switch (raw.type) {
      case 'header':
        lines.push(style.bold(style.cyan(String(textNode?.text ?? ''))));
        break;
      case 'section': {
        if (textNode?.text) lines.push(mrkdwn(String(textNode.text)));
        const fields = raw.fields as { text?: string }[] | undefined;
        for (const field of fields ?? []) lines.push(mrkdwn(String(field.text ?? '')).replace(/\n/g, ': '));
        break;
      }
      case 'context': {
        const elements = raw.elements as { text?: string }[] | undefined;
        for (const el of elements ?? []) lines.push(style.dim(mrkdwn(String(el.text ?? ''))));
        break;
      }
      case 'divider':
        lines.push(style.dim('-'.repeat(64)));
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

/**
 * Slack mrkdwn -> terminal. Links become `label (url)`, *bold* becomes bold.
 *
 * Order matters: emoji shortcodes and snake_case identifiers both contain
 * underscores, so they have to be consumed before the italic rule runs, and the
 * italic rule itself only fires on word boundaries. Otherwise `:red_circle:`
 * and `orders(created_at, status)` both come out mangled.
 */
function renderMrkdwn(text: string, channelNames: Map<string, string>): string {
  return text
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_m, url, label) => `${style.blue(String(label))} ${style.dim(`(${url})`)}`)
    .replace(/<(https?:\/\/[^>]+)>/g, (_m, url) => style.blue(String(url)))
    .replace(/<#([A-Z0-9_]+)(?:\|[^>]*)?>/g, (_m, id) => style.magenta(`#${channelNames.get(String(id)) ?? String(id)}`))
    .replace(/<@([A-Z0-9]+)>/g, (_m, id) => style.magenta(`@${String(id)}`))
    .replace(/:([a-z_]+):/g, (m, name) => EMOJI[String(name)] ?? m)
    .replace(/\*([^*\n]+)\*/g, (_m, inner) => style.bold(String(inner)))
    .replace(/(^|[\s([])_([^_\n]+)_(?=[\s.,;:!?)\]]|$)/g, (_m, lead, inner) => `${String(lead)}${style.dim(String(inner))}`)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const EMOJI: Record<string, string> = {
  rotating_light: '[!]',
  red_circle: '[HIGH]',
  large_orange_circle: '[MED]',
  large_yellow_circle: '[LOW]',
  white_circle: '[low]',
  warning: '[warn]',
  memo: '[doc]',
  robot_face: '',
  hourglass_flowing_sand: '...',
};

export function banner(text: string): string {
  return `\n${style.bold(style.yellow(`-- ${text} `))}${style.dim('-'.repeat(Math.max(0, 62 - text.length)))}\n`;
}

/** Frames a message the way it would appear in a Slack channel. */
export function slackFrame(channel: string, body: string): string {
  const bar = style.dim('|');
  return [
    style.dim(`  .-- #${channel}`),
    ...body.split('\n').map((line) => `  ${bar} ${line}`),
    style.dim(`  '--`),
  ].join('\n');
}

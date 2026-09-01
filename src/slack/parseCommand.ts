import { SEVERITIES, STATUSES } from '../core/types.js';
import type { IncidentStatus, Severity } from '../core/types.js';
import { UsageError } from '../util/errors.js';

export type ParsedCommand =
  | { kind: 'declare'; severity: Severity; title: string }
  | { kind: 'note'; key?: string; text: string }
  | { kind: 'status'; key?: string; status: IncidentStatus }
  | { kind: 'resolve'; key?: string }
  | { kind: 'show'; key?: string }
  | { kind: 'list'; scope: 'open' | 'all' }
  | { kind: 'help' };

const KEY_PATTERN = /^INC-\d{4}-\d{1,6}$/i;
const DEFAULT_SEVERITY: Severity = 'sev2';

/**
 * Parses the raw text of `/incident …`.
 *
 * Kept pure and separate from Bolt: the whole surface area of the command
 * grammar is testable without a Slack client, and the same parser backs the
 * offline demo CLI.
 */
export function parseCommand(raw: string): ParsedCommand {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (text === '') return { kind: 'help' };

  const [head, ...rest] = text.split(' ');
  const sub = head!.toLowerCase();

  switch (sub) {
    case 'declare':
    case 'open':
    case 'start':
      return parseDeclare(rest);

    case 'note':
    case 'log': {
      const { key, remainder } = takeKey(rest);
      if (remainder.length === 0) {
        throw new UsageError('What happened? Usage: `/incident note <what you just observed>`');
      }
      return { kind: 'note', key, text: remainder.join(' ') };
    }

    case 'status': {
      const { key, remainder } = takeKey(rest);
      const value = remainder[0]?.toLowerCase();
      if (!value || !isStatus(value)) {
        throw new UsageError(`Usage: \`/incident status <${STATUSES.filter((s) => s !== 'resolved').join('|')}>\``);
      }
      if (value === 'resolved') {
        throw new UsageError('Use `/incident resolve` so the postmortem gets drafted.');
      }
      return { kind: 'status', key, status: value };
    }

    case 'resolve':
    case 'close': {
      const { key } = takeKey(rest);
      return { kind: 'resolve', key };
    }

    case 'show': {
      const { key } = takeKey(rest);
      return { kind: 'show', key };
    }

    case 'list':
    case 'ls': {
      const scope = rest[0]?.toLowerCase();
      if (scope && scope !== 'open' && scope !== 'all') {
        throw new UsageError('Usage: `/incident list [open|all]`');
      }
      return { kind: 'list', scope: (scope as 'open' | 'all') ?? 'open' };
    }

    case 'help':
    case '-h':
    case '--help':
      return { kind: 'help' };

    default:
      throw new UsageError(
        `Unknown subcommand \`${sub}\`. Try \`declare\`, \`note\`, \`status\`, \`resolve\`, \`list\`, or \`help\`.`,
      );
  }
}

function parseDeclare(tokens: string[]): ParsedCommand {
  let severity = DEFAULT_SEVERITY;
  const words = [...tokens];

  // Severity may lead (`declare sev1 checkout is down`) or be flagged
  // (`declare checkout is down --sev1`). Both read naturally under pressure.
  const flagIndex = words.findIndex((w) => isSeverity(w.replace(/^--?/, '').toLowerCase()));
  if (flagIndex === 0 || (flagIndex > 0 && words[flagIndex]!.startsWith('-'))) {
    severity = words[flagIndex]!.replace(/^--?/, '').toLowerCase() as Severity;
    words.splice(flagIndex, 1);
  }

  const title = words.join(' ').trim();
  if (title === '') {
    throw new UsageError('Describe what is broken. Usage: `/incident declare [sev1|sev2|sev3] <what is broken>`');
  }
  if (title.length > 200) {
    throw new UsageError('Keep the title under 200 characters — the detail belongs in `/incident note`.');
  }
  return { kind: 'declare', severity, title };
}

/** Pulls a leading `INC-YYYY-NNNN` off the argument list, if present. */
function takeKey(tokens: string[]): { key?: string; remainder: string[] } {
  const first = tokens[0];
  if (first && KEY_PATTERN.test(first)) {
    return { key: first.toUpperCase(), remainder: tokens.slice(1) };
  }
  return { remainder: tokens };
}

function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

function isStatus(value: string): value is IncidentStatus {
  return (STATUSES as readonly string[]).includes(value);
}

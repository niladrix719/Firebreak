/** Base class for errors Firebreak raises deliberately, as opposed to bugs. */
export class FirebreakError extends Error {
  /** Safe to show a Slack user verbatim. */
  readonly userFacing: boolean;

  constructor(message: string, options: { userFacing?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.userFacing = options.userFacing ?? false;
  }
}

/** The user asked for something we can't do — bad subcommand, missing title, etc. */
export class UsageError extends FirebreakError {
  constructor(message: string) {
    super(message, { userFacing: true });
  }
}

/** The command was fine but the world isn't in the right state for it. */
export class ConflictError extends FirebreakError {
  constructor(message: string) {
    super(message, { userFacing: true });
  }
}

export class NotFoundError extends FirebreakError {
  constructor(message: string) {
    super(message, { userFacing: true });
  }
}

/** An upstream (Slack / GitHub / Anthropic) call failed. */
export class UpstreamError extends FirebreakError {
  constructor(
    readonly service: 'slack' | 'github' | 'anthropic',
    message: string,
    cause?: unknown,
  ) {
    super(`[${service}] ${message}`, { cause });
  }
}

export function messageFor(err: unknown): string {
  if (err instanceof FirebreakError && err.userFacing) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

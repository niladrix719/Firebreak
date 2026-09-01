import { logger } from './logger.js';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  label: string;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retryable by default: transport errors, 429, and 5xx. Never 4xx — those won't heal. */
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  const code = (err as { code?: string })?.code;
  return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

/**
 * Exponential backoff with full jitter, so a fleet of retries doesn't sync up.
 * See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 * for the case against fixed or additive jitter.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 250;
  const max = opts.maxDelayMs ?? 4000;
  const retryable = opts.isRetryable ?? isTransient;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !retryable(err)) break;
      const ceiling = Math.min(max, base * 2 ** (attempt - 1));
      const delay = Math.round(Math.random() * ceiling);
      logger.warn({ label: opts.label, attempt, delay }, 'retrying after transient failure');
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Bounded-concurrency map — keeps N+1 detail fetches from stampeding an API. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

import { describe, expect, it, vi } from 'vitest';
import { isTransient, mapWithConcurrency, withRetry } from '../src/util/retry.js';
import { newId, slugify } from '../src/util/ids.js';
import { formatDuration, formatStamp, hoursAgo } from '../src/util/time.js';
import { looksLikeRevert, splitChangeId } from '../src/github/client.js';
import { messageFor, UpstreamError, UsageError } from '../src/util/errors.js';

const noSleep = async () => {};

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const fn = vi.fn(async () => 'ok');
    expect(await withRetry(fn, { label: 't', sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      if (++attempts < 3) throw Object.assign(new Error('flaky'), { status: 503 });
      return 'ok';
    });
    expect(await withRetry(fn, { label: 't', sleep: noSleep })).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up after the attempt budget and rethrows the last error', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('always down'), { status: 500 });
    });
    await expect(withRetry(fn, { label: 't', attempts: 2, sleep: noSleep })).rejects.toThrow('always down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx, which will never heal', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    });
    await expect(withRetry(fn, { label: 't', sleep: noSleep })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off with jitter bounded by maxDelayMs', async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('down'), { status: 500 });
    });
    await expect(
      withRetry(fn, {
        label: 't',
        attempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 250,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toThrow();
    expect(delays).toHaveLength(3);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(250);
  });

  describe('isTransient', () => {
    it.each([
      [{ status: 429 }, true],
      [{ status: 500 }, true],
      [{ status: 503 }, true],
      [{ status: 408 }, true],
      [{ status: 404 }, false],
      [{ status: 401 }, false],
      [{ code: 'ECONNRESET' }, true],
      [{ code: 'ENOTFOUND' }, true],
      [{ code: 'EACCES' }, false],
      [new Error('plain'), false],
    ])('classifies %o as transient=%s', (err, expected) => {
      expect(isTransient(err)).toBe(expected);
    });
  });
});

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const items = [50, 10, 30, 5, 20];
    const results = await mapWithConcurrency(items, 2, async (n) => {
      await new Promise((r) => setTimeout(r, n / 10));
      return n * 2;
    });
    expect(results).toEqual([100, 20, 60, 10, 40]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Checkout API returning 502s!')).toBe('checkout-api-returning-502s');
  });

  it('strips leading and trailing separators', () => {
    expect(slugify('  --Hello, World--  ')).toBe('hello-world');
  });

  it('trims to the limit on a word boundary', () => {
    const slug = slugify('the quick brown fox jumps over the lazy dog', 20);
    expect(slug.length).toBeLessThanOrEqual(20);
    expect(slug).not.toMatch(/-$/);
    expect(slug).toBe('the-quick-brown-fox');
  });

  it('falls back rather than returning an empty string', () => {
    expect(slugify('!!!')).toBe('incident');
    expect(slugify('')).toBe('incident');
  });

  it('handles a single word longer than the limit', () => {
    expect(slugify('a'.repeat(50), 10)).toHaveLength(10);
  });
});

describe('newId', () => {
  it('sorts lexicographically by creation time', () => {
    const early = newId('inc', new Date('2026-01-01T00:00:00Z'));
    const late = newId('inc', new Date('2026-06-01T00:00:00Z'));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('is unique within the same millisecond', () => {
    const now = new Date();
    const ids = new Set(Array.from({ length: 500 }, () => newId('tl', now)));
    expect(ids.size).toBe(500);
  });

  it('keeps the prefix', () => {
    expect(newId('inc')).toMatch(/^inc_/);
  });
});

describe('time helpers', () => {
  it('formats durations', () => {
    expect(formatDuration('2026-09-01T14:00:00Z', '2026-09-01T14:48:00Z')).toBe('48m');
    expect(formatDuration('2026-09-01T14:00:00Z', '2026-09-01T17:12:00Z')).toBe('3h 12m');
    expect(formatDuration('2026-09-01T14:00:00Z', '2026-09-01T14:00:00Z')).toBe('0m');
  });

  it('reports an impossible duration as unknown rather than a negative number', () => {
    expect(formatDuration('2026-09-01T15:00:00Z', '2026-09-01T14:00:00Z')).toBe('unknown');
    expect(formatDuration('not-a-date', '2026-09-01T14:00:00Z')).toBe('unknown');
  });

  it('formats an unambiguous UTC stamp', () => {
    expect(formatStamp('2026-09-01T14:02:33.412Z')).toBe('2026-09-01 14:02 UTC');
  });

  it('passes through a value it cannot parse', () => {
    expect(formatStamp('whenever')).toBe('whenever');
  });

  it('subtracts hours', () => {
    expect(hoursAgo(48, new Date('2026-09-03T00:00:00Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('github id helpers', () => {
  it('splits a change id on the first colon only', () => {
    expect(splitChangeId('pr:482')).toEqual(['pr', '482']);
    expect(splitChangeId('commit:abc:def')).toEqual(['commit', 'abc:def']);
    expect(splitChangeId('nocolon')).toEqual(['', 'nocolon']);
  });

  it('recognises reverts, rollbacks, and hotfixes', () => {
    expect(looksLikeRevert('Revert "Enable keep-alive"', null)).toBe(true);
    expect(looksLikeRevert('Emergency hotfix', null)).toBe(true);
    expect(looksLikeRevert('Deploy', 'This is a rollback of #12')).toBe(true);
    expect(looksLikeRevert('Add a feature', 'Nothing unusual here')).toBe(false);
    // "reverted" should not trip a word-boundary match on unrelated prose.
    expect(looksLikeRevert('Add reversible migration', null)).toBe(false);
  });
});

describe('errors', () => {
  it('marks usage errors as safe to show a user', () => {
    expect(messageFor(new UsageError('try `/incident help`'))).toBe('try `/incident help`');
  });

  it('does not leak an upstream message as user-facing text', () => {
    const err = new UpstreamError('github', 'token expired');
    expect(err.userFacing).toBe(false);
    expect(err.message).toBe('[github] token expired');
  });

  it('stringifies a non-Error throw', () => {
    expect(messageFor('boom')).toBe('boom');
  });
});

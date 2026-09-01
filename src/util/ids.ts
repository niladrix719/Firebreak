import { randomUUID } from 'node:crypto';

/**
 * Lexicographically sortable ID: millisecond timestamp + random suffix.
 * Sorting by ID sorts by creation time, which keeps timeline queries cheap.
 */
export function newId(prefix: string, now: Date = new Date()): string {
  const ts = now.getTime().toString(36).padStart(9, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 10);
  return `${prefix}_${ts}${rand}`;
}

/** Turns "Checkout latency spike" into "checkout-latency-spike". */
export function slugify(input: string, maxLength = 40): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug || 'incident';
  // Trim on a word boundary so we don't leave a dangling half-word.
  return slug.slice(0, maxLength).replace(/-[^-]*$/, '') || slug.slice(0, maxLength);
}

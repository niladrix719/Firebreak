import type { ChangeDetail, ChangeEvent } from '../core/types.js';

export interface FixtureChange extends ChangeEvent {
  detail: ChangeDetail;
}

const REPO = 'https://github.com/acme/storefront';

/** Minutes before the incident is declared. */
function at(base: Date, minutesBefore: number): string {
  return new Date(base.getTime() - minutesBefore * 60_000).toISOString();
}

/**
 * A plausible 48 hours in a real service's history, built around one incident:
 * checkout returning 502s. Two changes are genuinely suspicious, one is a red
 * herring that *sounds* related, and the rest are noise — which is the whole
 * point. A correlator that just returns "the most recent PR" gets this wrong.
 */
export function storefrontChanges(declaredAt: Date = new Date()): FixtureChange[] {
  return [
    {
      id: 'deploy:99182',
      kind: 'deploy',
      title: 'Deploy to production (success) — main@8f2c1a4',
      url: `${REPO}/deployments`,
      author: 'deploy-bot',
      at: at(declaredAt, 34),
      sha: '8f2c1a4e9d3b7f6a5c2e1d0b9a8f7e6d5c4b3a29',
      prNumber: null,
      environment: 'production',
      detail: {
        body: 'Rolling deploy of main@8f2c1a4 to production (12/12 tasks healthy).',
        filesChanged: ['services/checkout/session.ts', 'services/checkout/redis.ts', 'infra/redis/production.tf'],
        additions: 214,
        deletions: 96,
        isRevert: false,
      },
    },
    {
      id: 'pr:482',
      kind: 'merge',
      title: '#482 Move checkout session storage from in-process cache to Redis',
      url: `${REPO}/pull/482`,
      author: 'rhee',
      at: at(declaredAt, 51),
      sha: '8f2c1a4e9d3b7f6a5c2e1d0b9a8f7e6d5c4b3a29',
      prNumber: 482,
      environment: null,
      detail: {
        body:
          'Sessions were pinned to a single instance, so a rolling restart logged everyone out mid-checkout.\n\n' +
          'This moves them into the shared Redis cluster. Connection pool is sized at 32 per task; ' +
          'we have 12 tasks, so 384 connections against a cluster configured for `maxclients 512`.\n\n' +
          'Rolled out behind `checkout.redis_sessions`, currently at 100%.',
        filesChanged: [
          'services/checkout/session.ts',
          'services/checkout/redis.ts',
          'services/checkout/session.test.ts',
          'infra/redis/production.tf',
          'config/flags.yaml',
        ],
        additions: 214,
        deletions: 96,
        isRevert: false,
      },
    },
    {
      id: 'pr:481',
      kind: 'merge',
      title: '#481 Raise checkout page copy limit to 240 characters',
      url: `${REPO}/pull/481`,
      author: 'okonkwo',
      at: at(declaredAt, 96),
      sha: 'b1c9e77a',
      prNumber: 481,
      environment: null,
      detail: {
        // The red herring: says "checkout" everywhere, touches nothing that runs.
        body: 'Marketing asked for longer promotional copy on the checkout page. Content only.',
        filesChanged: ['content/checkout/en-US.json', 'content/checkout/de-DE.json'],
        additions: 8,
        deletions: 8,
        isRevert: false,
      },
    },
    {
      id: 'pr:480',
      kind: 'merge',
      title: '#480 Add composite index on orders(created_at, status)',
      url: `${REPO}/pull/480`,
      author: 'valdez',
      at: at(declaredAt, 260),
      sha: 'c4d8f21b',
      prNumber: 480,
      environment: null,
      detail: {
        body: 'The admin order report was doing a sequential scan. Adds a concurrent index; no lock on writes.',
        filesChanged: ['migrations/20260901_orders_created_at_idx.sql', 'services/admin/reports.ts'],
        additions: 31,
        deletions: 4,
        isRevert: false,
      },
    },
    {
      id: 'deploy:99180',
      kind: 'deploy',
      title: 'Deploy to staging (success) — main@c4d8f21b',
      url: `${REPO}/deployments`,
      author: 'deploy-bot',
      at: at(declaredAt, 300),
      sha: 'c4d8f21b',
      prNumber: null,
      environment: 'staging',
      detail: {
        body: 'Staging deploy.',
        filesChanged: ['migrations/20260901_orders_created_at_idx.sql'],
        additions: 31,
        deletions: 4,
        isRevert: false,
      },
    },
    {
      id: 'pr:479',
      kind: 'merge',
      title: '#479 Revert "Enable HTTP keep-alive between edge and checkout"',
      url: `${REPO}/pull/479`,
      author: 'rhee',
      at: at(declaredAt, 1_180),
      sha: 'e7a3b90c',
      prNumber: 479,
      environment: null,
      detail: {
        body:
          'Reverts #474. Edge was holding connections open past the ALB idle timeout and we saw a ' +
          'handful of 502s in the p99 during yesterday evening. Reverting while we work out the right timeout pairing.',
        filesChanged: ['infra/edge/nginx.conf', 'services/checkout/server.ts'],
        additions: 6,
        deletions: 44,
        isRevert: true,
      },
    },
    {
      id: 'pr:477',
      kind: 'merge',
      title: '#477 Bump pino from 9.12.0 to 9.13.1',
      url: `${REPO}/pull/477`,
      author: 'dependabot[bot]',
      at: at(declaredAt, 1_600),
      sha: 'a0b1c2d3',
      prNumber: 477,
      environment: null,
      detail: {
        body: 'Automated dependency update.',
        filesChanged: ['package.json', 'package-lock.json'],
        additions: 12,
        deletions: 12,
        isRevert: false,
      },
    },
  ];
}


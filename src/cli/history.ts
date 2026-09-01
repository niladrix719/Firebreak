import { IncidentService } from '../core/incidentService.js';
import type { IncidentStore, LlmPort } from '../core/ports.js';
import type { Severity } from '../core/types.js';
import { FakeChat, FakeGitHub } from '../testing/fakes.js';
import type { FixtureChange } from '../testing/fixtures.js';

interface HistoryScript {
  daysAgo: number;
  hour: number;
  severity: Severity;
  title: string;
  declaredBy: { id: string; name: string };
  durationMinutes: number;
  notes: string[];
  changes: (declaredAt: Date) => FixtureChange[];
}

const REPO = 'https://github.com/acme/storefront';

function change(
  declaredAt: Date,
  minutesBefore: number,
  partial: Omit<FixtureChange, 'at' | 'url'> & { url?: string },
): FixtureChange {
  return {
    ...partial,
    url: partial.url ?? (partial.prNumber ? `${REPO}/pull/${partial.prNumber}` : `${REPO}/deployments`),
    at: new Date(declaredAt.getTime() - minutesBefore * 60_000).toISOString(),
  };
}

const detail = (files: string[], body: string, extra: Partial<FixtureChange['detail']> = {}) => ({
  body,
  filesChanged: files,
  additions: extra.additions ?? files.length * 18,
  deletions: extra.deletions ?? files.length * 5,
  isRevert: extra.isRevert ?? false,
});

/**
 * Past incidents, so the MCP server has a history to answer questions about
 * rather than a single row. Dates are relative to now, so the demo reads the
 * same whenever you run it.
 */
const SCRIPTS: HistoryScript[] = [
  {
    daysAgo: 1,
    hour: 9,
    severity: 'sev3',
    title: 'Search results page intermittently missing product images',
    declaredBy: { id: 'U0MARIN', name: 'marin' },
    durationMinutes: 47,
    notes: [
      'About one in twenty search results renders with a broken image.',
      'CDN is returning 403 on a subset of image keys.',
      'Signing key rotated last night and the old key was removed before the cache expired.',
      'Re-added the previous key, 403s stopped. Will remove it after the 24h TTL.',
    ],
    changes: (d) => [
      change(d, 620, {
        id: 'pr:471',
        kind: 'merge',
        title: '#471 Rotate CDN image signing key',
        author: 'marin',
        sha: 'd41f8a2b',
        prNumber: 471,
        environment: null,
        detail: detail(['infra/cdn/signing.tf', 'services/media/sign.ts'], 'Quarterly key rotation.'),
      }),
      change(d, 1_400, {
        id: 'pr:470',
        kind: 'merge',
        title: '#470 Add pagination to the search API',
        author: 'okonkwo',
        sha: 'ab77e001',
        prNumber: 470,
        environment: null,
        detail: detail(['services/search/api.ts', 'services/search/api.test.ts'], 'Cursor pagination for search.'),
      }),
    ],
  },
  {
    daysAgo: 8,
    hour: 22,
    severity: 'sev1',
    title: 'Payments failing for all customers — gateway returning 503',
    declaredBy: { id: 'U0RHEE', name: 'rhee' },
    durationMinutes: 92,
    notes: [
      'Every charge attempt is failing. This is a full payments outage.',
      'Gateway status page is green; the 503 is coming from our side of the connection.',
      'Our egress IP allowlist entry with the gateway expired at 22:00 UTC.',
      'Gateway support re-added the range. Charges are succeeding again.',
      'Backfilling the 1,411 failed charges from the retry queue.',
      'Backfill complete, queue drained, error rate at zero for 15 minutes.',
    ],
    changes: (d) => [
      change(d, 180, {
        id: 'deploy:98410',
        kind: 'deploy',
        title: 'Deploy to production (success) — main@77c1de0',
        author: 'deploy-bot',
        sha: '77c1de0f',
        prNumber: null,
        environment: 'production',
        detail: detail(['services/payments/client.ts'], 'Routine deploy.'),
      }),
      change(d, 2_800, {
        id: 'pr:462',
        kind: 'merge',
        title: '#462 Move NAT gateway to a dedicated subnet',
        author: 'valdez',
        sha: '5b2ee9c1',
        prNumber: 462,
        environment: null,
        detail: detail(
          ['infra/network/nat.tf', 'infra/network/subnets.tf'],
          'Splits egress onto its own subnet ahead of the multi-AZ work. Egress IP is unchanged.',
        ),
      }),
    ],
  },
  {
    daysAgo: 20,
    hour: 15,
    severity: 'sev2',
    title: 'Order confirmation emails delayed by up to 40 minutes',
    declaredBy: { id: 'U0VALDEZ', name: 'valdez' },
    durationMinutes: 134,
    notes: [
      'Support is seeing customers report no confirmation email after checkout.',
      'Orders are being written correctly — this is delivery only, not data loss.',
      'The email worker queue depth is at 40k and climbing.',
      'Worker concurrency was lowered from 20 to 4 in a config change three days ago.',
      'Restored concurrency to 20. Queue is draining at roughly 900/min.',
      'Queue empty. Backlog fully delivered.',
    ],
    changes: (d) => [
      change(d, 4_300, {
        id: 'pr:448',
        kind: 'merge',
        title: '#448 Reduce email worker concurrency to limit SES throttling',
        author: 'okonkwo',
        sha: '9ac0be31',
        prNumber: 448,
        environment: null,
        detail: detail(
          ['config/workers.yaml', 'services/email/worker.ts'],
          'We tripped an SES send-rate limit last week. Dropping concurrency 20 -> 4 as a stopgap.',
        ),
      }),
    ],
  },
];

/** Writes the historical incidents into `store`. Returns the keys created. */
export async function seedHistory(store: IncidentStore, llm: LlmPort, now: Date = new Date()): Promise<string[]> {
  const keys: string[] = [];

  for (const script of [...SCRIPTS].sort((a, b) => b.daysAgo - a.daysAgo)) {
    const declaredAt = new Date(now);
    declaredAt.setUTCDate(declaredAt.getUTCDate() - script.daysAgo);
    declaredAt.setUTCHours(script.hour, 4, 0, 0);

    const github = new FakeGitHub(script.changes(declaredAt));
    const chat = new FakeChat();

    // A clock that walks forward through the incident, so timeline entries land
    // in a plausible order instead of all sharing one timestamp.
    let cursor = declaredAt.getTime();
    const step = (script.durationMinutes * 60_000) / (script.notes.length + 2);
    const clock = () => new Date((cursor += step) - step);

    const service = new IncidentService(
      { store, github, chat, llm },
      { lookbackHours: 72, lookbackLimit: 30, clock },
    );

    const declared = await service.declare({
      title: script.title,
      severity: script.severity,
      actor: script.declaredBy,
    });
    await declared.investigate();

    for (const [index, note] of script.notes.entries()) {
      if (index === 1) {
        await service.setStatus({
          ref: { channelId: declared.channel!.id },
          status: 'identified',
          actor: script.declaredBy,
        });
      }
      await service.addNote({ ref: { channelId: declared.channel!.id }, text: note, actor: script.declaredBy });
    }

    await service.resolve({ ref: { channelId: declared.channel!.id }, actor: script.declaredBy });
    keys.push(declared.incident.key);
  }

  return keys;
}

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ChangeEvent,
  CorrelationReport,
  Incident,
  IncidentStatus,
  TimelineEntry,
} from '../core/types.js';
import type { IncidentStore } from '../core/ports.js';
import { MIGRATIONS } from './schema.js';
import { logger } from '../util/logger.js';

type Row = Record<string, unknown>;

/**
 * SQLite-backed store using Node's built-in driver — no native build step,
 * which keeps `npm install` honest on any machine running Node >= 22.5.
 */
export class SqliteIncidentStore implements IncidentStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row | undefined;
    const current = Number(row?.user_version ?? 0);
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[i]!);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
        this.db.exec('COMMIT');
        logger.debug({ migration: i + 1 }, 'applied migration');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  // --- incidents ----------------------------------------------------------

  async createIncident(incident: Incident): Promise<Incident> {
    this.db
      .prepare(
        `INSERT INTO incidents
           (id, key, title, severity, status, declared_by, declared_by_name, declared_at,
            resolved_at, channel_id, channel_name, correlation_summary, postmortem_url, postmortem_markdown)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        incident.id,
        incident.key,
        incident.title,
        incident.severity,
        incident.status,
        incident.declaredBy,
        incident.declaredByName,
        incident.declaredAt,
        incident.resolvedAt,
        incident.channelId,
        incident.channelName,
        incident.correlationSummary,
        incident.postmortemUrl,
        incident.postmortemMarkdown,
      );
    return incident;
  }

  async updateIncident(id: string, patch: Partial<Incident>): Promise<Incident> {
    const columns: Record<keyof Incident, string> = {
      id: 'id',
      key: 'key',
      title: 'title',
      severity: 'severity',
      status: 'status',
      declaredBy: 'declared_by',
      declaredByName: 'declared_by_name',
      declaredAt: 'declared_at',
      resolvedAt: 'resolved_at',
      channelId: 'channel_id',
      channelName: 'channel_name',
      correlationSummary: 'correlation_summary',
      postmortemUrl: 'postmortem_url',
      postmortemMarkdown: 'postmortem_markdown',
    };

    const sets: string[] = [];
    const values: (string | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key as keyof Incident];
      if (!column || key === 'id') continue;
      sets.push(`${column} = ?`);
      values.push(value === undefined ? null : (value as string | null));
    }

    if (sets.length > 0) {
      this.db.prepare(`UPDATE incidents SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    }

    const updated = await this.getIncident(id);
    if (!updated) throw new Error(`incident ${id} disappeared during update`);
    return updated;
  }

  async getIncident(idOrKey: string): Promise<Incident | null> {
    const row = this.db
      .prepare('SELECT * FROM incidents WHERE id = ? OR key = ? COLLATE NOCASE LIMIT 1')
      .get(idOrKey, idOrKey) as Row | undefined;
    return row ? toIncident(row) : null;
  }

  async getIncidentByChannel(channelId: string): Promise<Incident | null> {
    const row = this.db.prepare('SELECT * FROM incidents WHERE channel_id = ?').get(channelId) as Row | undefined;
    return row ? toIncident(row) : null;
  }

  async listIncidents(filter: { status?: IncidentStatus; limit: number }): Promise<Incident[]> {
    const rows = filter.status
      ? (this.db
          .prepare('SELECT * FROM incidents WHERE status = ? ORDER BY declared_at DESC LIMIT ?')
          .all(filter.status, filter.limit) as Row[])
      : (this.db
          .prepare('SELECT * FROM incidents ORDER BY declared_at DESC LIMIT ?')
          .all(filter.limit) as Row[]);
    return rows.map(toIncident);
  }

  /**
   * `INC-2026-0007`. Increments inside a transaction so two simultaneous
   * `/incident declare` calls can never be handed the same key.
   */
  async nextIncidentKey(now: Date): Promise<string> {
    const year = String(now.getUTCFullYear());
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO incident_counters (year, value) VALUES (?, 0) ON CONFLICT(year) DO NOTHING')
        .run(year);
      this.db.prepare('UPDATE incident_counters SET value = value + 1 WHERE year = ?').run(year);
      const row = this.db.prepare('SELECT value FROM incident_counters WHERE year = ?').get(year) as Row;
      this.db.exec('COMMIT');
      return `INC-${year}-${String(Number(row.value)).padStart(4, '0')}`;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- timeline -----------------------------------------------------------

  async appendTimeline(entry: TimelineEntry): Promise<TimelineEntry> {
    this.db
      .prepare(
        `INSERT INTO timeline_entries (id, incident_id, at, kind, author_id, author_name, text)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(entry.id, entry.incidentId, entry.at, entry.kind, entry.authorId, entry.authorName, entry.text);
    return entry;
  }

  async getTimeline(incidentId: string): Promise<TimelineEntry[]> {
    const rows = this.db
      // rowid, not id: two entries can share a millisecond, and when they do
      // the order responders typed them in is the only correct order.
      .prepare('SELECT * FROM timeline_entries WHERE incident_id = ? ORDER BY at ASC, rowid ASC')
      .all(incidentId) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      incidentId: String(r.incident_id),
      at: String(r.at),
      kind: String(r.kind) as TimelineEntry['kind'],
      authorId: String(r.author_id),
      authorName: String(r.author_name),
      text: String(r.text),
    }));
  }

  // --- changes ------------------------------------------------------------

  async saveChanges(incidentId: string, changes: ChangeEvent[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO incident_changes (incident_id, change_id, at, payload) VALUES (?,?,?,?)
       ON CONFLICT(incident_id, change_id) DO UPDATE SET payload = excluded.payload, at = excluded.at`,
    );
    this.db.exec('BEGIN');
    try {
      for (const change of changes) stmt.run(incidentId, change.id, change.at, JSON.stringify(change));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async getChanges(incidentId: string): Promise<ChangeEvent[]> {
    const rows = this.db
      .prepare('SELECT payload FROM incident_changes WHERE incident_id = ? ORDER BY at DESC')
      .all(incidentId) as Row[];
    return rows.map((r) => JSON.parse(String(r.payload)) as ChangeEvent);
  }

  // --- correlation --------------------------------------------------------

  async saveCorrelation(incidentId: string, report: CorrelationReport): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO correlations (incident_id, created_at, payload) VALUES (?,?,?)
         ON CONFLICT(incident_id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
      )
      .run(incidentId, new Date().toISOString(), JSON.stringify(report));
  }

  async getCorrelation(incidentId: string): Promise<CorrelationReport | null> {
    const row = this.db.prepare('SELECT payload FROM correlations WHERE incident_id = ?').get(incidentId) as
      | Row
      | undefined;
    return row ? (JSON.parse(String(row.payload)) as CorrelationReport) : null;
  }

  close(): void {
    this.db.close();
  }
}

function toIncident(row: Row): Incident {
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    id: String(row.id),
    key: String(row.key),
    title: String(row.title),
    severity: String(row.severity) as Incident['severity'],
    status: String(row.status) as Incident['status'],
    declaredBy: String(row.declared_by),
    declaredByName: String(row.declared_by_name),
    declaredAt: String(row.declared_at),
    resolvedAt: str(row.resolved_at),
    channelId: str(row.channel_id),
    channelName: str(row.channel_name),
    correlationSummary: str(row.correlation_summary),
    postmortemUrl: str(row.postmortem_url),
    postmortemMarkdown: str(row.postmortem_markdown),
  };
}

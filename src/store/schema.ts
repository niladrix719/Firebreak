/**
 * Forward-only migrations, applied by index against SQLite's `user_version`.
 * Never edit a migration that has shipped — append a new one.
 */
export const MIGRATIONS: readonly string[] = [
  // 1 — core tables
  `
  CREATE TABLE incidents (
    id                   TEXT PRIMARY KEY,
    key                  TEXT NOT NULL UNIQUE,
    title                TEXT NOT NULL,
    severity             TEXT NOT NULL,
    status               TEXT NOT NULL,
    declared_by          TEXT NOT NULL,
    declared_by_name     TEXT NOT NULL,
    declared_at          TEXT NOT NULL,
    resolved_at          TEXT,
    channel_id           TEXT,
    channel_name         TEXT,
    correlation_summary  TEXT,
    postmortem_url       TEXT,
    postmortem_markdown  TEXT
  );

  CREATE UNIQUE INDEX idx_incidents_channel
    ON incidents(channel_id) WHERE channel_id IS NOT NULL;
  CREATE INDEX idx_incidents_status ON incidents(status, declared_at DESC);

  CREATE TABLE timeline_entries (
    id           TEXT PRIMARY KEY,
    incident_id  TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    at           TEXT NOT NULL,
    kind         TEXT NOT NULL,
    author_id    TEXT NOT NULL,
    author_name  TEXT NOT NULL,
    text         TEXT NOT NULL
  );
  CREATE INDEX idx_timeline_incident ON timeline_entries(incident_id, at);

  CREATE TABLE incident_changes (
    incident_id  TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    change_id    TEXT NOT NULL,
    at           TEXT NOT NULL,
    payload      TEXT NOT NULL,
    PRIMARY KEY (incident_id, change_id)
  );
  CREATE INDEX idx_changes_incident ON incident_changes(incident_id, at DESC);

  CREATE TABLE correlations (
    incident_id  TEXT PRIMARY KEY REFERENCES incidents(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    payload      TEXT NOT NULL
  );

  CREATE TABLE incident_counters (
    year   TEXT PRIMARY KEY,
    value  INTEGER NOT NULL
  );
  `,
];

/**
 * Writes the historical incidents into a database without running the featured
 * incident. Useful for populating a database the MCP server will read.
 *
 *   npm run seed -- --db ./data/firebreak.db
 */
import { config as loadDotenv } from 'dotenv';
import { HeuristicLlm } from '../llm/heuristic.js';
import { SqliteIncidentStore } from '../store/sqliteStore.js';
import { seedHistory } from './history.js';

loadDotenv({ quiet: true });

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dbIndex = argv.indexOf('--db');
  const dbPath = dbIndex >= 0 ? (argv[dbIndex + 1] ?? '') : (process.env.DATABASE_PATH ?? './data/demo.db');

  const store = new SqliteIncidentStore(dbPath);
  const keys = await seedHistory(store, new HeuristicLlm());
  store.close();

  process.stdout.write(`Seeded ${keys.length} incident(s) into ${dbPath}: ${keys.join(', ')}\n`);
}

main().catch((err) => {
  process.stderr.write(`seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

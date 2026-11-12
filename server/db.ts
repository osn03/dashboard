import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDb(path: string, only?: (file: string) => boolean): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db, only);
  return db;
}

/** Applies numbered .sql files in order, each in its own transaction, exactly once. */
export function migrate(db: DB, only: (file: string) => boolean = () => true): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM _migrations').all().map((r: any) => r.name));
  const applied: string[] = [];
  const pending = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && only(f) && !done.has(f)).sort();
  // Upgrading an existing database: keep a consistent copy of it first.
  if (pending.length && done.size && db.name && db.name !== ':memory:') {
    const dir = join(dirname(db.name), 'backups');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `before-upgrade-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    if (!existsSync(target)) db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
    console.log(`[db] Backup written to ${target} before applying ${pending.length} schema update(s).`);
  }
  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    })();
    applied.push(file);
  }
  return applied;
}

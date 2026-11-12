// Consistent online backup of the SQLite database (safe while the app is running).
// Usage: npm run backup            -> data/backups/dashboard-<timestamp>.db
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const src = process.env.DATABASE_PATH ?? './data/dashboard.db';
if (!existsSync(src)) {
  console.error(`No database at ${src}`);
  process.exit(1);
}
mkdirSync('data/backups', { recursive: true });
const dest = `data/backups/dashboard-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
const db = new Database(src, { readonly: true });
await db.backup(dest);
db.close();
console.log(`Backup written to ${dest}`);

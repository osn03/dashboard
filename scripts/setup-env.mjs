// Creates .env from .env.example with freshly generated secrets.
// Secrets are written to disk only; nothing secret is printed.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('data', { recursive: true });
if (existsSync('.env')) {
  console.log('.env already exists - left untouched.');
  process.exit(0);
}
const key = randomBytes(32).toString('base64');
const text = readFileSync('.env.example', 'utf8').replace(
  /^APP_ENCRYPTION_KEY=.*$/m,
  `APP_ENCRYPTION_KEY=${key}`,
);
writeFileSync('.env', text, { mode: 0o600 });
console.log('Created .env with a new encryption key (value not shown).');

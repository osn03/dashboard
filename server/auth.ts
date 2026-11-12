import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DB } from './db';

const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const dummyHash = hashPassword(randomBytes(8).toString('hex'));

export function hasUser(db: DB): boolean {
  return !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
}

export function createUser(db: DB, username: string, password: string): string {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?,?,?,?)').run(
    id, username, hashPassword(password), new Date().toISOString(),
  );
  return id;
}

export function checkLogin(db: DB, username: string, password: string): string | null {
  const row = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username) as
    | { id: string; password_hash: string }
    | undefined;
  // Always do the hash work so timing does not reveal whether the user exists.
  const ok = verifyPassword(password, row?.password_hash ?? dummyHash);
  return row && ok ? row.id : null;
}

/** Returns the raw token (goes in the cookie); only its SHA-256 is stored. */
export function createSession(db: DB, userId: string): { token: string; maxAge: number } {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now).toISOString());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?,?,?,?)').run(
    sha(token), userId, new Date(now + SESSION_DAYS * 864e5).toISOString(), new Date(now).toISOString(),
  );
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function sessionUser(db: DB, token: string | undefined): { id: string; username: string } | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha(token), new Date().toISOString()) as { id: string; username: string } | undefined;
  return row ?? null;
}

export function destroySession(db: DB, token: string | undefined): void {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

/** Small in-memory limiter for login attempts. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const ok = list.length < this.max;
    if (ok) list.push(now);
    this.hits.set(key, list);
    return ok;
  }
  reset(key: string): void {
    this.hits.delete(key);
  }
}

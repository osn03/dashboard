// Thin HTTP adapter for Google OAuth 2.0 and the Calendar API v3.
// No database or UI knowledge lives here. `fetchFn` and `sleep` are injectable for tests.

export const GOOGLE_SCOPES = [
  // Narrowest scopes that cover: list my calendars, read events on them, write events where I may.
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Send PKCE parameters in addition to the client secret (default on). */
  pkce?: boolean;
}

export class GoogleApiError extends Error {
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
    this.name = 'GoogleApiError';
  }
}
/** The refresh token no longer works (revoked, expired, or password changed). */
export class GoogleRevokedError extends Error {
  constructor() {
    super('Google access was revoked or has expired');
    this.name = 'GoogleRevokedError';
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

const RETRY_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);
const MAX_ATTEMPTS = 4;

export class GoogleClient {
  constructor(
    private cfg: GoogleConfig,
    private fetchFn: FetchFn = (u, i) => fetch(u, i),
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  authUrl(state: string, codeChallenge: string): string {
    const p = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline', // we need a refresh token
      prompt: 'consent', // ensures a refresh token is issued on reconnect too
      include_granted_scopes: 'false',
      state,
      ...(this.cfg.pkce === false ? {} : { code_challenge: codeChallenge, code_challenge_method: 'S256' }),
    });
    return `${AUTH_URL}?${p}`;
  }

  private async tokenRequest(params: Record<string, string>): Promise<any> {
    let res: Response;
    try {
      res = await this.fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }).toString(),
      });
    } catch {
      throw new GoogleApiError(0, 'Could not reach Google to sign in');
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'invalid_grant') throw new GoogleRevokedError();
      // error codes only - never log or surface token material
      throw new GoogleApiError(res.status, `Google sign-in failed (${data.error ?? res.status})`, data.error);
    }
    return data;
  }

  async exchangeCode(code: string, codeVerifier: string) {
    const d = await this.tokenRequest({
      grant_type: 'authorization_code', code, redirect_uri: this.cfg.redirectUri,
      ...(this.cfg.pkce === false ? {} : { code_verifier: codeVerifier }),
    });
    return { accessToken: d.access_token as string, expiresIn: Number(d.expires_in ?? 3600), refreshToken: d.refresh_token as string | undefined, scope: String(d.scope ?? '') };
  }

  async refresh(refreshToken: string) {
    const d = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { accessToken: d.access_token as string, expiresIn: Number(d.expires_in ?? 3600) };
  }

  /** Best effort; failure to revoke must not block disconnecting locally. */
  async revoke(token: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(REVOKE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }).toString(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * One Calendar API call with bounded retries (network errors, 429, 5xx, rate-limit 403s)
   * and exponential backoff. Callers make writes idempotent (client event ids, If-Match),
   * so a retry can never create a duplicate.
   */
  async api<T = any>(accessToken: string, method: string, path: string, opts: ApiOptions = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, v);
    const url = `${API}${path}${qs.size ? `?${qs}` : ''}`;
    let lastError: GoogleApiError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) await this.sleep(Math.min(8000, 400 * 2 ** (attempt - 2)) + Math.floor(Math.random() * 200));
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method,
          headers: {
            authorization: `Bearer ${accessToken}`,
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...opts.headers,
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch {
        lastError = new GoogleApiError(0, 'Could not reach Google Calendar');
        continue;
      }
      if (res.status === 204) return undefined as T;
      const data: any = await res.json().catch(() => ({}));
      if (res.ok) return data as T;

      const reason: string | undefined = data?.error?.errors?.[0]?.reason;
      const err = new GoogleApiError(res.status, data?.error?.message ?? `Google Calendar error ${res.status}`, reason);
      const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && !!reason && RETRY_REASONS.has(reason));
      if (!retryable) throw err;
      lastError = err;
    }
    throw lastError ?? new GoogleApiError(0, 'Google Calendar request failed');
  }
}

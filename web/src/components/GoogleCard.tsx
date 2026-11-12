import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { formatDate, formatTime, instantToZoned } from '../../../shared/dates';
import type { GoogleStatus } from '../../../shared/types';
import { useActions, useGoogle } from '../api';
import { useEnv } from '../env';
import { useUI } from '../ui';

interface Draft {
  selected: string[];
  defaultId: string | null;
  mirrorId: string | null;
  colors: Record<string, string | null>;
}
const draftOf = (st: GoogleStatus): Draft => ({
  selected: st.calendars.filter((c) => c.selected).map((c) => c.id),
  defaultId: st.defaultCalendarId,
  mirrorId: st.mirrorCalendarId,
  colors: {},
});

/** Settings card: Google accounts, which calendars to show, colours, default destination, mirroring. */
export function GoogleCard() {
  const google = useGoogle();
  const actions = useActions();
  const { toast } = useUI();
  const { tz, settings, today } = useEnv();
  const [params, setParams] = useSearchParams();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState('');

  // Result of the OAuth redirect (?google=connected|denied|error).
  useEffect(() => {
    const r = params.get('google');
    if (!r) return;
    if (r === 'connected') toast('Google account connected');
    else if (r === 'denied') toast('Google sign-in was cancelled. Nothing was connected.', { kind: 'error' });
    else toast(params.get('message') ?? 'Google sign-in failed', { kind: 'error' });
    setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const st = google.data;
  if (google.isLoading) return <section className="card"><h2>Google Calendar</h2><p className="empty">Checking connection…</p></section>;
  if (!st) return <section className="card"><h2>Google Calendar</h2><p className="banner error">Could not load the connection status.</p></section>;

  const d = draft ?? draftOf(st);
  const dirty = draft !== null;
  const edit = (p: Partial<Draft>) => setDraft({ ...d, ...p });
  const when = (iso: string | null) => {
    if (!iso) return 'not synced yet';
    const z = instantToZoned(iso, tz);
    return `synced ${z.date === today ? '' : `${formatDate(z.date)} `}${formatTime(iso, tz, settings.hour12)}`;
  };
  const act = (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    void fn().finally(() => setBusy(''));
  };
  const live = (accountId: string) => st.accounts.find((a) => a.id === accountId)?.status === 'connected';
  const writable = st.calendars.filter((c) => !c.readOnly && live(c.accountId));
  const many = st.accounts.length > 1;
  const name = (c: { summary: string; accountLabel: string | null }) => (many ? `${c.summary} (${c.accountLabel ?? 'account'})` : c.summary);

  return (
    <section className="card" aria-label="Google Calendar">
      <h2>
        Google Calendar{' '}
        <span className={`badge ${st.state === 'connected' ? '' : 'subtle'}`}>
          {st.state === 'connected' ? `${st.accounts.length} account${st.accounts.length > 1 ? 's' : ''}` : st.state === 'disconnected' ? 'Not connected' : 'Not set up'}
        </span>
      </h2>

      {st.state === 'not_configured' && (
        <>
          <p>To connect, this app needs its own Google OAuth client. It takes about ten minutes, once:</p>
          <ol className="steps">
            <li>Create an OAuth client (type “Web application”) in Google Cloud Console and enable the Google Calendar API.</li>
            <li>Add the redirect URI shown in <code>.env.example</code> to the client.</li>
            <li>Put the client ID and secret in the <code>.env</code> file in the project folder (never in chat), then restart the app.</li>
          </ol>
          <p className="hint">Exact steps are in README.md under “Connect Google Calendar”. Until then, events are stored in this app only.</p>
        </>
      )}

      {st.state === 'disconnected' && (
        <>
          <p>Show your Google calendars here and create or edit events in them.</p>
          <p className="hint">
            You will be asked for two permissions: see your list of calendars, and view and edit events. No access to mail, contacts or files is requested. No invitations are ever sent from this app.
          </p>
          <button className="btn primary" onClick={() => void actions.googleConnect()}>Connect Google Calendar</button>
        </>
      )}

      {st.state === 'connected' && (
        <>
          {st.accounts.map((acc) => {
            const cals = st.calendars.filter((c) => c.accountId === acc.id);
            return (
              <div key={acc.id} className="g-account">
                <h3>
                  {acc.label ?? 'Google account'}
                  {acc.status === 'revoked' && <span className="badge danger">Access lost</span>}
                  {acc.status === 'demo' && <span className="badge subtle">Demo data – not a real account</span>}
                </h3>
                {acc.status === 'revoked' && (
                  <p className="banner error" role="alert">
                    Google no longer accepts this app’s access for this account (revoked or expired). Its events below are the last copy received and may be out of date. Sign in with the same account to restore it. Your tasks and local events are unaffected.
                  </p>
                )}
                {acc.status === 'connected' && acc.lastError && (
                  <p className="banner error" role="alert">Last sync failed: {acc.lastError} Cached events are still shown and may be out of date.</p>
                )}
                <ul className="cal-list">
                  {cals.map((c) => (
                    <li key={c.id}>
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={d.selected.includes(c.id)}
                          onChange={(e) => edit({ selected: e.target.checked ? [...d.selected, c.id] : d.selected.filter((x) => x !== c.id) })}
                        />
                        <span>{c.summary}</span>
                      </label>
                      <input
                        type="color"
                        className="color-pick"
                        value={d.colors[c.id] ?? c.color}
                        aria-label={`Colour for ${c.summary}`}
                        title="Colour in this dashboard"
                        onChange={(e) => edit({ colors: { ...d.colors, [c.id]: e.target.value } })}
                      />
                      {c.colorOverridden && d.colors[c.id] === undefined && (
                        <button className="btn small ghost" onClick={() => edit({ colors: { ...d.colors, [c.id]: null } })}>Use Google’s colour</button>
                      )}
                      {c.primary && <span className="badge subtle">Primary</span>}
                      {c.readOnly && <span className="badge subtle">Read-only</span>}
                      {c.isDefault && <span className="badge">New events</span>}
                      {c.isMirror && <span className="badge">Time-block copies</span>}
                      {c.selected && acc.status !== 'demo' && (
                        <span className={c.lastError ? 'badge danger' : 'muted small'} title={c.lastError ?? undefined}>
                          {c.lastError ? `Sync failed · last ${when(c.lastSyncedAt)}` : when(c.lastSyncedAt)}
                        </span>
                      )}
                    </li>
                  ))}
                  {cals.length === 0 && <li className="empty">No calendars found in this account.</li>}
                </ul>
                <div className="btn-group">
                  {acc.status === 'revoked' && <button className="btn primary" onClick={() => void actions.googleConnect()}>Reconnect</button>}
                  <button
                    className="btn small ghost danger"
                    disabled={!!busy}
                    onClick={() => {
                      if (confirm(`Disconnect ${acc.label ?? 'this account'}? Its events disappear from this app; nothing is deleted in Google.`)) act('disconnect', () => actions.googleDisconnect(acc.id).then(() => setDraft(null)));
                    }}
                  >
                    Disconnect this account
                  </button>
                </div>
              </div>
            );
          })}

          <div className="field-row" style={{ marginTop: '0.8rem' }}>
            <label className="field">
              <span>New events go to</span>
              <select value={d.defaultId ?? ''} onChange={(e) => edit({ defaultId: e.target.value || null })}>
                <option value="">This app only (not Google)</option>
                {writable.filter((c) => d.selected.includes(c.id)).map((c) => (
                  <option key={c.id} value={c.id}>{name(c)}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Copy task time blocks to</span>
              <select value={d.mirrorId ?? ''} onChange={(e) => edit({ mirrorId: e.target.value || null })}>
                <option value="">Off – time blocks stay in this app</option>
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>{name(c)}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="hint">
            You can still pick another calendar each time you create an event. Time-block copies are optional: each block gets exactly one copy, kept up to date and removed with the block; switching it off removes the copies.
            {st.mirrorPending > 0 && ` ${st.mirrorPending} copy update${st.mirrorPending > 1 ? 's are' : ' is'} waiting to be sent to Google.`}
          </p>

          <div className="btn-group" style={{ marginTop: '0.8rem' }}>
            <button
              className="btn primary"
              disabled={!dirty || !!busy}
              onClick={() =>
                act('save', async () => {
                  const ok = await actions.googleSetCalendars({
                    selected: d.selected,
                    defaultCalendarId: d.defaultId && d.selected.includes(d.defaultId) ? d.defaultId : null,
                    mirrorCalendarId: d.mirrorId,
                    colors: d.colors,
                  });
                  if (ok) setDraft(null);
                })
              }
            >
              {busy === 'save' ? 'Saving and syncing…' : 'Save calendar settings'}
            </button>
            {dirty && <button className="btn ghost" onClick={() => setDraft(null)}>Discard changes</button>}
            {st.canConnect && (
              <>
                <button className="btn" disabled={!!busy} onClick={() => act('sync', actions.googleSync)}>
                  {busy === 'sync' || st.syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <button className="btn" disabled={!!busy} onClick={() => void actions.googleConnect()} title="Sign in with another Google account to show its calendars too">
                  Add another Google account
                </button>
              </>
            )}
          </div>
          <p className="hint" style={{ marginTop: '0.5rem' }}>
            Syncs automatically every few minutes while the app is running. Each calendar is synced on its own, so the same calendar reached through two accounts appears twice here — tick only one of them.
          </p>

          {st.hidden.length > 0 && (
            <>
              <h3>Hidden Google events</h3>
              <ul className="cal-list">
                {st.hidden.map((h) => (
                  <li key={h.calendarId + h.eventKey}>
                    <span className="check-field">{h.title || '(No title)'}</span>
                    <button className="btn small ghost" onClick={() => void actions.unhideGoogleEvent(h.calendarId, h.eventKey)}>Show again</button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}

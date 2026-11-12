import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Settings } from '../../../shared/types';
import { api, useActions, useAssistantStatus, useTraining } from '../api';
import { formatDate, formatTime, instantToZoned } from '../../../shared/dates';
import { TrainingSource } from '../components/Training';
import { GoogleCard } from '../components/GoogleCard';
import { useEnv } from '../env';
import { useUI } from '../ui';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const zones: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['Europe/Oslo', 'UTC'];
  }
})();

function IntervalsCard() {
  const q = useTraining();
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const st = q.data?.status;
  const label = { not_configured: 'Not set up', never_synced: 'Connected, not imported yet', ok: 'Connected', error: 'Import failing', demo: 'Demo data' } as const;
  return (
    <section className="card" aria-label="Intervals.icu">
      <h2>Intervals.icu {st && <span className={`badge ${st.state === 'ok' ? '' : st.state === 'error' ? 'danger' : 'subtle'}`}>{label[st.state]}</span>}</h2>
      {!st ? (
        <p className="empty">Checking…</p>
      ) : st.state === 'not_configured' ? (
        <>
          <p>Read-only import of planned workouts, completed activities and wellness values.</p>
          <ol className="steps">
            <li>In Intervals.icu open <strong>Settings → Developer Settings</strong>; note the <strong>Athlete ID</strong> and create or copy the <strong>API key</strong>.</li>
            <li>Put them in <code>.env</code> as <code>INTERVALS_ATHLETE_ID</code> and <code>INTERVALS_API_KEY</code> (never in chat), then restart the app.</li>
          </ol>
        </>
      ) : (
        <>
          <p className="muted">
            {st.state === 'demo' ? 'Sample data, not a real account.' : `Athlete ${st.athleteId}.`} {st.counts.planned} planned entries, {st.counts.activities} activities, {st.counts.wellnessDays} wellness days stored. Nothing is ever written to Intervals.icu.
          </p>
          <TrainingSource status={st} />
          {st.state !== 'demo' && (
            <button className="btn" disabled={busy} onClick={() => { setBusy(true); void actions.trainingSync().finally(() => setBusy(false)); }}>
              {busy || st.syncing ? 'Importing…' : 'Import now'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function AssistantCard() {
  const q = useAssistantStatus();
  const qc = useQueryClient();
  const { settings, tz } = useEnv();
  const actions = useActions();
  const [checking, setChecking] = useState(false);
  const st = q.data;
  const cc = st?.claudeCode;
  const when = (iso: string) => `${formatDate(instantToZoned(iso, tz).date)} ${formatTime(iso, tz, settings.hour12)}`;
  const recheck = async () => {
    setChecking(true);
    try {
      qc.setQueryData(['assistant', 'status'], await api('GET', '/api/assistant/status?fresh=1'));
    } catch {
      /* the status query shows the error */
    }
    setChecking(false);
  };
  const knownModel = st?.claudeCodeModels.some((m) => m.id === settings.claudeCodeModel);
  const model = st?.claudeCodeModels.find((m) => m.id === settings.claudeCodeModel);

  return (
    <section className="card" aria-label="Assistant">
      <h2>Assistant {st && <span className={`badge ${st.state === 'ready' ? '' : st.state === 'demo' ? 'subtle' : 'danger'}`}>{st.state === 'ready' ? 'Ready' : st.state === 'demo' ? 'Off in demo mode' : 'Not ready'}</span>}</h2>
      <p className="muted">Optional. The dashboard works fully without it.</p>

      {st && st.state !== 'demo' && (
        <>
          <label className="field" style={{ maxWidth: 420 }}>
            <span>Assistant runs on</span>
            <select value={st.provider} onChange={(e) => void actions.saveSettings({ ...settings, aiProvider: e.target.value as typeof settings.aiProvider })}>
              {st.providers.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.configured ? '' : ' — not set up'}</option>
              ))}
            </select>
          </label>
          <p className="hint">
            The selected option is the only one used. If it is unavailable the assistant stops with a message; it never switches to another provider or to API billing by itself.
          </p>
          {st.remoteBlocked && <p className="banner error" role="alert">{st.message}</p>}

          {st.provider === 'claude_code' && !st.remoteBlocked && (
            <div className="g-account">
              <h3>Claude Code on this computer</h3>
              <dl className="facts">
                <dt>Status</dt>
                <dd>
                  <span className={`badge ${cc?.state === 'ready' ? '' : 'danger'}`}>
                    {{ ready: 'Connected', not_installed: 'Not installed', signed_out: 'Not signed in', conflict: 'Wrong sign-in', error: 'Problem' }[cc?.state ?? 'error']}
                  </span>
                </dd>
                <dt>Signed in with</dt>
                <dd>
                  {cc?.authMethod === 'claude.ai'
                    ? `Claude subscription${cc.plan ? ` (${cc.plan} plan)` : ''} — as reported by Claude Code`
                    : cc?.authMethod
                      ? `${cc.authMethod} — not a subscription sign-in`
                      : 'Could not be determined'}
                </dd>
                {cc?.loginExpiresAt && (<><dt>Sign-in valid until</dt><dd>{when(cc.loginExpiresAt)}</dd></>)}
                <dt>Version</dt><dd>{cc?.version ?? '—'}</dd>
                <dt>Program</dt><dd className="path">{cc?.path ?? 'not found'}</dd>
              </dl>
              {cc && cc.state !== 'ready' && <p className="banner error" role="alert">{cc.message}</p>}
              {cc && (cc.state === 'not_installed' || cc.state === 'signed_out' || cc.state === 'conflict') && (
                <ol className="steps">
                  {cc.state === 'not_installed' && <li>Install Claude Code for Windows, following Anthropic’s instructions at code.claude.com/docs/en/setup. If it is installed somewhere unusual, set <code>CLAUDE_CODE_PATH</code> in <code>.env</code> to the full path of <code>claude.exe</code>.</li>}
                  {cc.state === 'conflict' && <li>In a terminal run <code>claude auth logout</code>.</li>}
                  <li>In a terminal run <code>claude auth login</code> and sign in with your Claude account in the browser window that opens. The dashboard never sees your password or sign-in token.</li>
                  <li>Come back here and press “Check again”.</li>
                </ol>
              )}
              {cc && cc.withheld.length > 0 && (
                <p className="hint">
                  Found in the dashboard’s configuration: {cc.withheld.join(', ')}. {cc.withheld.length > 1 ? 'These are' : 'This is'} not passed to Claude Code, so {cc.withheld.length > 1 ? 'they' : 'it'} cannot turn subscription use into API billing. {cc.withheld.includes('ANTHROPIC_API_KEY') && 'The API key is only used if you select “Claude API” above.'}
                </p>
              )}
              {st.planLimitResetsAt && (
                <p className="banner">
                  Claude reported that your plan’s included usage is used up until about {when(st.planLimitResetsAt)}.
                  {settings.claudeCodeAllowExtraUsage ? ' Requests are being charged to paid extra usage.' : ' The assistant is paused until then.'}
                </p>
              )}
              <button className="btn small" disabled={checking} onClick={() => void recheck()}>{checking ? 'Checking…' : 'Check again'}</button>

              <label className="field" style={{ maxWidth: 420, marginTop: '0.7rem' }}>
                <span>Model</span>
                <select value={settings.claudeCodeModel} onChange={(e) => void actions.saveSettings({ ...settings, claudeCodeModel: e.target.value })}>
                  {st.claudeCodeModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  {!knownModel && <option value={settings.claudeCodeModel}>{settings.claudeCodeModel}</option>}
                </select>
              </label>
              {model && <p className={model.extraUsage ? 'banner' : 'hint'}>{model.note}</p>}
              <label className="check-field">
                <input type="checkbox" checked={settings.claudeCodeAllowExtraUsage} onChange={(e) => void actions.saveSettings({ ...settings, claudeCodeAllowExtraUsage: e.target.checked })} />
                <span>Allow paid extra usage when my plan’s included limit is used up</span>
              </label>
              <p className="hint">
                Assistant requests count against the same usage limits as Claude Code and the Claude apps on your subscription. When off (default), the assistant stops as soon as Claude reports that a request was charged to extra usage (usage credits) and stays paused until the limit resets. That first request has already been charged when this is detected. Some models can need usage credits on some plans regardless of this switch.
              </p>
            </div>
          )}

          {st.provider !== 'claude_code' && (
            <div className="g-account">
              <h3>{st.providerName}</h3>
              <p className={st.state === 'ready' ? 'muted' : 'banner error'}>{st.state === 'ready' ? `Model: ${st.model}. Every request is billed per use to your API account.` : st.message}</p>
              <details className="group">
                <summary>How to set up an API key</summary>
                <ol className="steps">
                  <li><strong>Claude API:</strong> console.anthropic.com → API keys; put it in <code>.env</code> as <code>ANTHROPIC_API_KEY</code> (optional: <code>ANTHROPIC_MODEL</code>).</li>
                  <li><strong>ChatGPT:</strong> platform.openai.com → API keys; put it in <code>.env</code> as <code>OPENAI_API_KEY</code> (optional: <code>OPENAI_MODEL</code>).</li>
                  <li>Never paste a key into a chat. Restart the app afterwards.</li>
                </ol>
              </details>
            </div>
          )}
        </>
      )}

      <label className="check-field">
        <input type="checkbox" checked={settings.aiIncludeTraining} onChange={(e) => void actions.saveSettings({ ...settings, aiIncludeTraining: e.target.checked })} />
        <span>Let the assistant read my training and wellness data</span>
      </label>
      <p className="hint">
        The assistant can only use the dashboard’s own lookup and proposal tools — it has no access to files, the shell, or the database, and every change waits for your confirmation. It receives what it looks up for your question: task titles and dates, event titles, times and locations. Event descriptions are not sent; training data only if switched on above.
      </p>
    </section>
  );
}

export function SettingsPage() {
  const { settings } = useEnv();
  const actions = useActions();
  const { toast } = useUI();
  const qc = useQueryClient();
  const [s, setS] = useState<Settings>(settings);
  const [perm, setPerm] = useState<string>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((c) => ({ ...c, [k]: v }));
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);

  return (
    <div className="page settings-page">
      <header className="page-head"><h1>Settings</h1></header>

      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          if (s.workEnd <= s.workStart) return toast('Working hours must end after they start.', { kind: 'error' });
          void actions.saveSettings(s);
        }}
      >
        <h2>Date and time</h2>
        <div className="field-row three">
          <label className="field">
            <span>Timezone</span>
            <input list="tz-list" value={s.timezone} onChange={(e) => set('timezone', e.target.value)} required />
            <datalist id="tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          </label>
          <label className="field">
            <span>Week starts on</span>
            <select value={s.weekStart} onChange={(e) => set('weekStart', Number(e.target.value))}>
              <option value={1}>Monday</option>
              <option value={7}>Sunday</option>
              <option value={6}>Saturday</option>
            </select>
          </label>
          <label className="field">
            <span>Time format</span>
            <select value={s.hour12 ? '12' : '24'} onChange={(e) => set('hour12', e.target.value === '12')}>
              <option value="24">24-hour (14:30)</option>
              <option value="12">12-hour (2:30 PM)</option>
            </select>
          </label>
        </div>

        <h2>Working hours</h2>
        <p className="hint">Used for the “time available” summary on Today.</p>
        <div className="field-row three">
          <label className="field"><span>Start</span><input type="time" value={s.workStart} onChange={(e) => set('workStart', e.target.value)} required /></label>
          <label className="field"><span>End</span><input type="time" value={s.workEnd} onChange={(e) => set('workEnd', e.target.value)} required /></label>
          <label className="field">
            <span>Default time block (minutes)</span>
            <input type="number" min={5} max={480} step={5} value={s.defaultBlockMin} onChange={(e) => set('defaultBlockMin', Number(e.target.value) || 60)} />
          </label>
        </div>
        <div className="weekday-picks" role="group" aria-label="Working days">
          {WEEKDAYS.map((n, i) => (
            <label key={n} className="chip-check">
              <input
                type="checkbox"
                checked={s.workDays.includes(i + 1)}
                onChange={(e) => set('workDays', e.target.checked ? [...s.workDays, i + 1].sort() : s.workDays.filter((d) => d !== i + 1))}
              />
              <span>{n}</span>
            </label>
          ))}
        </div>

        <h2>Appearance</h2>
        <div className="field-row three">
          <label className="field">
            <span>Theme</span>
            <select value={s.theme} onChange={(e) => set('theme', e.target.value as Settings['theme'])}>
              <option value="system">Match system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label className="field">
            <span>Calendar opens at hour</span>
            <input type="number" min={0} max={12} value={s.dayStartHour} onChange={(e) => set('dayStartHour', Number(e.target.value) || 0)} />
          </label>
        </div>
        <footer className="dialog-foot">
          <span className="spacer" />
          <button type="button" className="btn ghost" disabled={!dirty} onClick={() => setS(settings)}>Reset</button>
          <button type="submit" className="btn primary" disabled={!dirty}>Save settings</button>
        </footer>
      </form>

      <section className="card">
        <h2>Reminders</h2>
        <p>
          Browser notifications:{' '}
          <strong>
            {perm === 'granted' ? 'allowed' : perm === 'denied' ? 'blocked in this browser' : perm === 'unsupported' ? 'not supported by this browser' : 'not yet allowed'}
          </strong>
        </p>
        <p className="hint">
          Reminders are delivered while the dashboard is open in a browser tab. They always appear inside the app; with permission they also appear as system notifications.
          {perm === 'denied' && ' To enable them, allow notifications for this site in your browser’s site settings.'}
        </p>
        {perm === 'default' && (
          <button className="btn" onClick={() => void Notification.requestPermission().then(setPerm)}>Allow notifications</button>
        )}
      </section>

      <GoogleCard />

      <IntervalsCard />
      <AssistantCard />

      <section className="card">
        <h2>Your data</h2>
        <p>Everything is stored in a single SQLite file on this computer.</p>
        <div className="btn-group">
          <a className="btn" href="/api/export" download>Export as JSON</a>
        </div>
        <p className="hint">For a full backup you can restore from, run <code>npm run backup</code> in the project folder. See README for restore steps.</p>
      </section>

      <section className="card">
        <h2>Account</h2>
        <button
          className="btn"
          onClick={() => void api('POST', '/api/auth/logout').then(() => { qc.clear(); window.location.assign('/'); })}
        >
          Sign out
        </button>
      </section>
    </div>
  );
}

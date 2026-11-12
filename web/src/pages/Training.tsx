import { useState } from 'react';
import { Link } from 'react-router';
import { addDays, formatDate } from '../../../shared/dates';
import type { WellnessDay } from '../../../shared/types';
import { useActions, useTraining } from '../api';
import { NA, Spark, TotalsTable, TrainingRow, TrainingSource } from '../components/Training';
import { useEnv } from '../env';

const METRICS: { key: keyof WellnessDay; label: string; unit?: string; help: string }[] = [
  { key: 'ctl', label: 'Fitness (CTL)', help: 'Long-term training load, as calculated by Intervals.icu' },
  { key: 'atl', label: 'Fatigue (ATL)', help: 'Short-term training load, as calculated by Intervals.icu' },
  { key: 'form', label: 'Form (CTL − ATL)', help: 'Fitness minus fatigue' },
  { key: 'restingHr', label: 'Resting HR', unit: 'bpm', help: 'As recorded in Intervals.icu wellness' },
  { key: 'hrv', label: 'HRV', unit: 'ms', help: 'As recorded in Intervals.icu wellness' },
  { key: 'sleepHours', label: 'Sleep', unit: 'h', help: 'As recorded in Intervals.icu wellness' },
];

export function TrainingPage() {
  const { today } = useEnv();
  const [weekOf, setWeekOf] = useState<string | undefined>(undefined);
  const q = useTraining(weekOf);
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const t = q.data;

  if (q.isLoading) return <div className="page"><p className="empty">Loading training…</p></div>;
  if (!t) return <div className="page"><p className="banner error" role="alert">Could not load training data. Check that the server is running, then reload.</p></div>;

  if (t.status.state === 'not_configured') {
    return (
      <div className="page">
        <header className="page-head"><h1>Training</h1></header>
        <section className="card">
          <h2>Intervals.icu is not connected</h2>
          <p>Planned workouts, completed activities and wellness values can be imported read-only from your Intervals.icu account.</p>
          <ol className="steps">
            <li>In Intervals.icu open <strong>Settings → Developer Settings</strong> and note your <strong>Athlete ID</strong> and <strong>API key</strong>.</li>
            <li>Put them in the <code>.env</code> file in the project folder as <code>INTERVALS_ATHLETE_ID</code> and <code>INTERVALS_API_KEY</code> (never in chat).</li>
            <li>Restart the app.</li>
          </ol>
          <p className="hint">Nothing is ever written to Intervals.icu. To explore with sample data instead, run <code>npm run demo</code>.</p>
        </section>
      </div>
    );
  }

  const last14 = t.wellness.slice(-14);
  const latest = [...t.wellness].reverse();
  const pick = (k: keyof WellnessDay) => latest.find((w) => w[k] != null);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Training</h1>
        <span className="spacer" />
        {t.status.state !== 'demo' && (
          <button className="btn" disabled={busy} onClick={() => { setBusy(true); void actions.trainingSync().finally(() => setBusy(false)); }}>
            {busy || t.status.syncing ? 'Importing…' : 'Import now'}
          </button>
        )}
      </header>
      <TrainingSource status={t.status} />

      <div className="today-grid">
        <div className="col">
          <section className="card" aria-label="Today's training">
            <h2>Today</h2>
            {t.todayPlanned.length + t.todayCompleted.length === 0 ? (
              <p className="empty">No workout planned and no activity recorded today.</p>
            ) : (
              <ul className="tr-list">
                {t.todayPlanned.map((i) => <TrainingRow key={`p${i.id}`} item={i} />)}
                {t.todayCompleted.map((i) => <TrainingRow key={`a${i.id}`} item={i} />)}
              </ul>
            )}
          </section>

          <section className="card" aria-label="Upcoming training">
            <h2>Next 7 days</h2>
            {t.upcoming.length === 0 ? <p className="empty">Nothing planned.</p> : <ul className="tr-list">{t.upcoming.map((i) => <TrainingRow key={i.id} item={i} showDate />)}</ul>}
          </section>

          <section className="card" aria-label="Recent activities">
            <h2>Recent activities <span className="muted small">last 14 days</span></h2>
            {t.recent.length === 0 ? <p className="empty">No activities recorded.</p> : <ul className="tr-list">{t.recent.map((i) => <TrainingRow key={i.id} item={i} showDate />)}</ul>}
          </section>
        </div>

        <div className="col">
          <section className="card" aria-label="Weekly planned versus completed">
            <h2>
              Week of {formatDate(t.week.start)}
              <span className="spacer" />
              <span className="btn-group">
                <button className="btn small" aria-label="Previous week" onClick={() => setWeekOf(addDays(t.week.start, -7))}>‹</button>
                <button className="btn small" onClick={() => setWeekOf(undefined)}>This week</button>
                <button className="btn small" aria-label="Next week" onClick={() => setWeekOf(addDays(t.week.start, 7))}>›</button>
              </span>
            </h2>
            <TotalsTable planned={t.week.plannedTotals} completed={t.week.completedTotals} plannedDone={t.week.plannedDone} />
            <p className="hint">Planned and completed are separate totals and are never added together. A planned workout counts as done when Intervals.icu has paired an activity with it.</p>
          </section>

          <section className="card" aria-label="Load and recovery trends">
            <h2>Load and recovery <span className="muted small">last 14 days</span></h2>
            {t.wellness.length === 0 ? (
              <p className="empty">No wellness data has been recorded in Intervals.icu.</p>
            ) : (
              <table className="totals trends">
                <thead><tr><th scope="col">Measure</th><th scope="col">Latest</th><th scope="col">Trend</th></tr></thead>
                <tbody>
                  {METRICS.map((m) => {
                    const l = pick(m.key);
                    return (
                      <tr key={m.key}>
                        <th scope="row" title={m.help}>{m.label}</th>
                        <td>
                          {l ? <>{String(l[m.key])}{m.unit ? ` ${m.unit}` : ''}{l.date !== today && <span className="muted small"> ({formatDate(l.date)})</span>}</> : NA}
                        </td>
                        <td><Spark values={last14.map((w) => w[m.key] as number | null)} label={m.label} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="hint">Values are shown as recorded in Intervals.icu; “—” means nothing was recorded. This is not medical advice.</p>
          </section>
          <p className="hint">Workouts also appear in the <Link to="/calendar">calendar</Link>: with a start time on the schedule, otherwise in the Training row.</p>
        </div>
      </div>
    </div>
  );
}

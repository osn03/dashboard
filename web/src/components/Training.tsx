import { formatDate, formatDuration, formatTime, instantToZoned } from '../../../shared/dates';
import type { Sum, TrainingItem, TrainingStatus, TrainingTotals } from '../../../shared/types';
import { useEnv } from '../env';

/** "—" for values the source did not provide. Never shows a made-up zero. */
export const NA = <span className="na" title="Not provided by Intervals.icu">—</span>;

export function dur(min: number | null) {
  return min == null ? NA : formatDuration(min);
}

export function SumCell({ sum, unit, fmt }: { sum: Sum; unit?: string; fmt?: (n: number) => string }) {
  if (sum.value == null) return NA;
  return (
    <>
      {fmt ? fmt(sum.value) : sum.value}
      {unit ? ` ${unit}` : ''}
      {sum.missing > 0 && <span className="muted small" title="Items without a value are not included"> (+{sum.missing} not recorded)</span>}
    </>
  );
}

export function TrainingRow({ item, showDate }: { item: TrainingItem; showDate?: boolean }) {
  const { settings } = useEnv();
  return (
    <li className={`tr-item ${item.what}`}>
      <span className={`tr-mark ${item.what}${item.done && item.what === 'planned' ? ' done' : ''}`} aria-hidden>
        {item.what === 'completed' || item.done ? '✓' : '○'}
      </span>
      <div className="tr-main">
        <span className="tr-name">{item.name}</span>
        <span className="tr-meta">
          {showDate && <span>{formatDate(item.date)}</span>}
          <span>{item.time ? (settings.hour12 ? item.time : item.time) : item.what === 'planned' ? 'No set time' : 'Time not recorded'}</span>
          {item.sport && <span>{item.sport}</span>}
          <span>{item.durationMin == null ? 'duration not recorded' : formatDuration(item.durationMin)}</span>
          {item.distanceKm != null && <span>{item.distanceKm} km</span>}
          {item.load != null && <span>load {item.load}</span>}
          {item.avgHr != null && <span>{item.avgHr} bpm avg</span>}
          {item.what === 'planned' && item.done && <span className="badge">Completed</span>}
          {!item.detailsAvailable && <span className="badge subtle" title="This source does not share details through the Intervals.icu API">Details unavailable ({item.source})</span>}
        </span>
      </div>
    </li>
  );
}

export function TotalsTable({ planned, completed, plannedDone }: { planned: TrainingTotals; completed: TrainingTotals; plannedDone: number }) {
  return (
    <table className="totals">
      <thead>
        <tr><th scope="col"></th><th scope="col">Planned</th><th scope="col">Completed</th></tr>
      </thead>
      <tbody>
        <tr><th scope="row">Sessions</th><td>{planned.count}{planned.count > 0 && <span className="muted small"> ({plannedDone} done)</span>}</td><td>{completed.count}</td></tr>
        <tr><th scope="row">Time</th><td><SumCell sum={planned.durationMin} fmt={formatDuration} /></td><td><SumCell sum={completed.durationMin} fmt={formatDuration} /></td></tr>
        <tr><th scope="row">Distance</th><td><SumCell sum={planned.distanceKm} unit="km" /></td><td><SumCell sum={completed.distanceKm} unit="km" /></td></tr>
        <tr><th scope="row">Load</th><td><SumCell sum={planned.load} /></td><td><SumCell sum={completed.load} /></td></tr>
      </tbody>
    </table>
  );
}

/** One line describing where the training data comes from and how fresh it is. */
export function TrainingSource({ status }: { status: TrainingStatus }) {
  const { tz, settings, today } = useEnv();
  if (status.state === 'demo') return <p className="hint">Demo training data – not from a real Intervals.icu account.</p>;
  if (status.state === 'not_configured') return null;
  const at = status.lastSyncedAt;
  const z = at ? instantToZoned(at, tz) : null;
  return (
    <p className={status.lastError ? 'banner error' : 'hint'} role={status.lastError ? 'alert' : undefined}>
      {status.lastError ? `Import failed: ${status.lastError} ` : 'Source: Intervals.icu (read-only). '}
      {at ? `Last imported ${z!.date === today ? '' : `${formatDate(z!.date)} `}${formatTime(at, tz, settings.hour12)}.` : 'Not imported yet.'}
    </p>
  );
}

/** Tiny line chart; gaps are left where a day has no value. */
export function Spark({ values, label }: { values: (number | null)[]; label: string }) {
  const known = values.filter((v): v is number => v != null);
  if (known.length < 2) return <span className="muted small">not enough data</span>;
  const min = Math.min(...known);
  const max = Math.max(...known);
  const w = 120;
  const h = 28;
  const x = (i: number) => (i / (values.length - 1)) * (w - 4) + 2;
  const y = (v: number) => (max === min ? h / 2 : h - 3 - ((v - min) / (max - min)) * (h - 6));
  let path = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) pen = false;
    else {
      path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
  });
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}: from ${known[0]} to ${known[known.length - 1]} over ${values.length} days`}>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

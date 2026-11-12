import { useState } from 'react';
import { addMinutes, minutesToTime, timeToMinutes, zonedToInstant } from '../../../shared/dates';
import { useActions } from '../api';
import { useEnv } from '../env';

type Kind = 'task' | 'event' | 'note';

/** One-line capture for a task, an event or a note. */
export function QuickCapture() {
  const { today, tz, settings, now } = useEnv();
  const actions = useActions();
  const [kind, setKind] = useState<Kind>('task');
  const [text, setText] = useState('');
  const [forToday, setForToday] = useState(true);
  const [date, setDate] = useState(today);
  const nextHour = minutesToTime(Math.min(23 * 60, (Math.floor(timeToMinutes(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now)) / 60) + 1) * 60));
  const [start, setStart] = useState(nextHour);
  const [dur, setDur] = useState(String(settings.defaultBlockMin));
  const [allDay, setAllDay] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    let ok: unknown;
    if (kind === 'task') {
      ok = await actions.createTask({ title: value, plannedDate: forToday ? today : null }, forToday ? 'Task added to today' : 'Task added to Inbox');
    } else if (kind === 'note') {
      ok = await actions.createNote(value);
    } else if (allDay) {
      ok = await actions.createEvent({ title: value, allDay: true, startDate: date, endDate: date });
    } else {
      const startAt = zonedToInstant(date, start, tz);
      ok = await actions.createEvent({ title: value, allDay: false, startAt, endAt: addMinutes(startAt, Math.max(5, Number(dur) || 60)) });
    }
    setBusy(false);
    if (ok) setText('');
  }

  return (
    <form
      className="capture"
      aria-label="Quick capture"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="capture-main">
        <div className="segmented" role="radiogroup" aria-label="What to capture">
          {(['task', 'event', 'note'] as Kind[]).map((k) => (
            <label key={k} className={kind === k ? 'on' : ''}>
              <input type="radio" name="capture-kind" checked={kind === k} onChange={() => setKind(k)} />
              {k[0].toUpperCase() + k.slice(1)}
            </label>
          ))}
        </div>
        <input
          className="capture-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={kind === 'task' ? 'Add a task…' : kind === 'event' ? 'Event title…' : 'Write a note…'}
          aria-label={`New ${kind}`}
          maxLength={300}
        />
        <button className="btn primary" type="submit" disabled={busy || !text.trim()}>Add</button>
      </div>
      {kind === 'task' && (
        <label className="check-field capture-opts">
          <input type="checkbox" checked={forToday} onChange={(e) => setForToday(e.target.checked)} />
          <span>Plan for today (otherwise it goes to the Inbox)</span>
        </label>
      )}
      {kind === 'event' && (
        <div className="capture-opts field-row four">
          <label className="field"><span>Date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></label>
          {!allDay && <label className="field"><span>Start</span><input type="time" value={start} onChange={(e) => setStart(e.target.value)} required /></label>}
          {!allDay && <label className="field"><span>Minutes</span><input type="number" min={5} max={1440} step={5} value={dur} onChange={(e) => setDur(e.target.value)} /></label>}
          <label className="check-field"><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /><span>All day</span></label>
        </div>
      )}
    </form>
  );
}

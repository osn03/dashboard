import { useState } from 'react';
import { addMinutes, formatDate, formatDuration, formatTime, instantToZoned, minutesToTime, timeToMinutes, zonedToInstant } from '../../../shared/dates';
import type { CalEvent } from '../../../shared/types';
import { useActions, useEvents, useGoogle, useTasks } from '../api';
import { useEnv } from '../env';
import { Dialog, useUI } from '../ui';

export function EventEditor() {
  const { eventEditor, closeEditors } = useUI();
  if (!eventEditor) return null;
  if ('event' in eventEditor && eventEditor.event.kind === 'training') return <TrainingDetails event={eventEditor.event} onClose={closeEditors} />;
  return 'event' in eventEditor ? (
    <EventForm key={eventEditor.event.id} event={eventEditor.event} onClose={closeEditors} />
  ) : (
    <EventForm key="new" defaults={eventEditor.defaults} onClose={closeEditors} />
  );
}

interface Defaults { date: string; start?: string; end?: string; allDay?: boolean; title?: string }
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Read-only view of an Intervals.icu workout or activity. */
function TrainingDetails({ event, onClose }: { event: CalEvent; onClose: () => void }) {
  const { tz, settings } = useEnv();
  const t = event.training!;
  const missing = <span className="na">not recorded</span>;
  return (
    <Dialog title={t.what === 'completed' ? 'Completed activity' : 'Planned workout'} onClose={onClose}>
      <div className="form">
        <p className="source-line"><span>Intervals.icu</span><span className="badge subtle">Read-only</span></p>
        <h3 className="plain-title">{event.title}</h3>
        <dl className="facts">
          <dt>When</dt>
          <dd>
            {event.allDay
              ? `${formatDate(event.startDate!, 'long')} · ${t.what === 'planned' ? 'no set time' : 'time not recorded'}`
              : `${formatDate(instantToZoned(event.startAt!, tz).date, 'long')} · ${formatTime(event.startAt!, tz, settings.hour12)}`}
          </dd>
          <dt>Sport</dt><dd>{t.sport ?? missing}</dd>
          <dt>Duration</dt><dd>{t.durationMin == null ? missing : formatDuration(t.durationMin)}</dd>
          <dt>Distance</dt><dd>{t.distanceKm == null ? missing : `${t.distanceKm} km`}</dd>
          <dt>Training load</dt><dd>{t.load == null ? missing : t.load}</dd>
        </dl>
        <p className="hint">Training is imported from Intervals.icu and cannot be changed here.</p>
        <footer className="dialog-foot"><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Close</button></footer>
      </div>
    </Dialog>
  );
}
const LOCAL = '__local__';

function EventForm({ event, defaults, onClose }: { event?: CalEvent; defaults?: Defaults; onClose: () => void }) {
  const { tz, settings } = useEnv();
  const actions = useActions();
  const { openTask } = useUI();
  const tasks = useTasks();
  const google = useGoogle();
  const isBlock = event?.kind === 'task_block';
  const task = isBlock ? tasks.data?.find((t) => t.id === event!.taskId) : undefined;
  const g = event?.google;
  const readOnly = !!g?.readOnly;
  const recurring = !!g?.recurringEventId;

  // Writable Google calendars the user has chosen to show.
  const liveAccounts = new Set((google.data?.accounts ?? []).filter((a) => a.status === 'connected').map((a) => a.id));
  const targets = (google.data?.calendars ?? []).filter((c) => c.selected && !c.readOnly && liveAccounts.has(c.accountId));
  const manyAccounts = (google.data?.accounts.length ?? 0) > 1;
  // A Google event that looks like the same thing as an Intervals.icu workout on that day.
  const gDay = g ? (event!.startDate ?? instantToZoned(event!.startAt!, tz).date) : '';
  const sameDay = useEvents(gDay || '2000-01-01', gDay || '2000-01-01');
  const twin = g ? (sameDay.data ?? []).find((e) => e.kind === 'training' && norm(e.title) === norm(event!.title)) : undefined;
  const defaultTarget = targets.find((c) => c.id === google.data?.defaultCalendarId)?.id ?? LOCAL;

  const zs = event?.startAt ? instantToZoned(event.startAt, tz) : null;
  const ze = event?.endAt ? instantToZoned(event.endAt, tz) : null;
  const defStart = defaults?.start ?? '09:00';
  const [title, setTitle] = useState(event?.title ?? defaults?.title ?? '');
  const [allDay, setAllDay] = useState(event?.allDay ?? defaults?.allDay ?? false);
  const [startDate, setStartDate] = useState(event?.startDate ?? zs?.date ?? defaults?.date ?? '');
  const [endDate, setEndDate] = useState(event?.endDate ?? ze?.date ?? defaults?.date ?? '');
  const [start, setStart] = useState(zs?.time ?? defStart);
  const [end, setEnd] = useState(
    ze?.time ?? defaults?.end ?? minutesToTime(Math.min(1439, timeToMinutes(defStart) + settings.defaultBlockMin)),
  );
  const [location, setLocation] = useState(event?.location ?? '');
  const [notes, setNotes] = useState(event?.notes ?? '');
  const [target, setTarget] = useState<string | null>(null); // null = follow the default until the user picks
  const [scope, setScope] = useState<'occurrence' | 'series'>('occurrence');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // One id per dialog: pressing Save again after a failure re-sends the same id, so Google cannot create a duplicate.
  const [clientId] = useState(() => crypto.randomUUID().replaceAll('-', ''));
  const saveTo = target ?? defaultTarget;

  async function save() {
    setError('');
    if (!isBlock && !title.trim()) return setError('Give the event a title.');
    if (!startDate) return setError('Choose a date.');
    let times: Record<string, unknown>;
    if (allDay) {
      if ((endDate || startDate) < startDate) return setError('The end date is before the start date.');
      times = { startDate, endDate: endDate || startDate };
    } else {
      const startAt = zonedToInstant(startDate, start, tz);
      let endAt = zonedToInstant(endDate || startDate, end, tz);
      // "22:00 - 01:00" on a single date means it ends the next day.
      if (endAt <= startAt && (endDate || startDate) === startDate && end < start) endAt = addMinutes(endAt, 24 * 60);
      if (endAt <= startAt) return setError('The end must be after the start.');
      times = { startAt, endAt };
    }
    const text = { title: title.trim(), location, notes };
    setBusy(true);
    let ok: unknown;
    if (!event) {
      ok = saveTo === LOCAL
        ? await actions.createEvent({ ...times, ...text, allDay } as never)
        : await actions.createGoogleEvent({ ...times, ...text, allDay, calendarId: saveTo, clientId });
    } else if (g) {
      // Send only what changed, so an untouched field can never overwrite a newer value in Google.
      const patch: Record<string, unknown> = { scope: recurring ? scope : 'occurrence' };
      if (text.title !== event.title) patch.title = text.title;
      if (location !== event.location) patch.location = location;
      if (notes !== event.notes) patch.notes = notes;
      for (const [k, v] of Object.entries(times)) if (v !== (event as never)[k]) patch[k] = v;
      ok = Object.keys(patch).length > 1 ? await actions.patchGoogleEvent(event, patch) : true;
    } else {
      ok = await actions.patchEvent(event.id, isBlock ? times : { ...times, ...text }, isBlock ? 'Time block updated' : 'Event saved');
    }
    setBusy(false);
    if (ok) onClose();
  }

  const heading = isBlock ? 'Time block' : !event ? 'New event' : readOnly ? 'Event (read-only)' : 'Edit event';

  return (
    <Dialog title={heading} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) void save();
        }}
      >
        {g && (
          <p className="source-line">
            <span className="dot" style={{ background: g.color ?? 'var(--muted)' }} aria-hidden />
            <span>Google Calendar · {g.calendarName}{manyAccounts && g.accountLabel ? ` (${g.accountLabel})` : ''}</span>
            {readOnly && <span className="badge subtle">Read-only</span>}
            {recurring && <span className="badge subtle">Repeats</span>}
            <span>Synced {formatTime(g.fetchedAt, tz, settings.hour12)}</span>
            {g.htmlLink && <a className="link" href={g.htmlLink} target="_blank" rel="noopener noreferrer">Open in Google Calendar</a>}
          </p>
        )}

        {g && twin && (
          <p className="banner">
            Possible duplicate: Intervals.icu has a {twin.training?.what === 'completed' ? 'completed activity' : 'planned workout'} called “{twin.title}” on this day. If this Google event is the same thing, you can hide it here; nothing is changed in Google or Intervals.icu.
          </p>
        )}
        {isBlock && event?.mirror && (
          <p className={event.mirror.state === 'failed' ? 'form-error' : 'source-line'}>
            {event.mirror.state === 'synced' && `A copy is kept in Google Calendar · ${event.mirror.calendarName}.`}
            {event.mirror.state === 'pending' && `A copy will be written to Google Calendar · ${event.mirror.calendarName}.`}
            {event.mirror.state === 'failed' && `The Google copy is not up to date: ${event.mirror.error} The block itself is saved; the copy is retried automatically.`}
          </p>
        )}
        {isBlock ? (
          <p className="block-task">
            Time block for task{' '}
            <button type="button" className="link" onClick={() => event?.taskId && openTask(event.taskId)}>
              {event!.title || 'Untitled task'}
            </button>
            {task?.status === 'done' && <span className="badge subtle">Task completed</span>}
          </p>
        ) : (
          <label className="field">
            <span>Title</span>
            <input autoFocus={!event} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} required disabled={readOnly} />
          </label>
        )}

        {!event && (
          <>
            {targets.length > 0 && (
              <label className="field">
                <span>Save to</span>
                <select value={saveTo} onChange={(e) => setTarget(e.target.value)}>
                  {targets.map((c) => (
                    <option key={c.id} value={c.id}>Google · {c.summary}{manyAccounts && c.accountLabel ? ` (${c.accountLabel})` : ''}</option>
                  ))}
                  <option value={LOCAL}>This app only (not in Google)</option>
                </select>
              </label>
            )}
            <label className="check-field">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              <span>All-day event</span>
            </label>
          </>
        )}

        {allDay ? (
          <div className="field-row">
            <label className="field">
              <span>From</span>
              <input type="date" value={startDate} disabled={readOnly} onChange={(e) => { setStartDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} required />
            </label>
            <label className="field">
              <span>To (inclusive)</span>
              <input type="date" value={endDate} min={startDate} disabled={readOnly} onChange={(e) => setEndDate(e.target.value)} />
            </label>
          </div>
        ) : (
          <div className="field-row three">
            <label className="field">
              <span>Date</span>
              <input type="date" value={startDate} disabled={readOnly} onChange={(e) => { setStartDate(e.target.value); setEndDate(e.target.value); }} required />
            </label>
            <label className="field">
              <span>Start</span>
              <input type="time" value={start} disabled={readOnly} onChange={(e) => setStart(e.target.value)} required />
            </label>
            <label className="field">
              <span>End</span>
              <input type="time" value={end} disabled={readOnly} onChange={(e) => setEnd(e.target.value)} required />
            </label>
          </div>
        )}

        {!isBlock && (
          <>
            <label className="field">
              <span>Location</span>
              <input value={location} disabled={readOnly} onChange={(e) => setLocation(e.target.value)} maxLength={300} />
            </label>
            <label className="field">
              <span>Notes</span>
              <textarea rows={3} value={notes} disabled={readOnly} onChange={(e) => setNotes(e.target.value)} />
            </label>
          </>
        )}

        {g && recurring && !readOnly && (
          <fieldset className="group">
            <legend>This event repeats. Apply changes or deletion to</legend>
            <label className="check-field">
              <input type="radio" name="scope" checked={scope === 'occurrence'} onChange={() => setScope('occurrence')} />
              <span>Only this occurrence</span>
            </label>
            <label className="check-field">
              <input type="radio" name="scope" checked={scope === 'series'} onChange={() => setScope('series')} />
              <span>The whole series (all occurrences)</span>
            </label>
            <p className="hint">“This and following” is not offered; use Google Calendar for that.</p>
          </fieldset>
        )}

        <p className="hint">
          {isBlock
            ? 'Changing or removing a time block never changes the task’s deadline. '
            : g
              ? readOnly
                ? 'You cannot change this event from here. '
                : `Changes are saved to Google Calendar${g.hasGuests ? '. This event has guests: no notifications are sent from this app' : ''}. `
              : !event && saveTo !== LOCAL
                ? 'Will be created in Google Calendar. No invitations or notifications are sent. '
                : 'Stored in this app (not in Google Calendar). '}
          Times use {settings.timezone}.
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}

        <footer className="dialog-foot">
          {event && isBlock && (
            <div className="btn-group">
              <button type="button" className="btn" onClick={() => void actions.deleteEvent(event.id, 'Moved back to the day’s tasks.').then(onClose)}>
                Remove from schedule
              </button>
              {task?.status === 'open' && (
                <button type="button" className="btn ghost" onClick={() => void actions.completeTask(task.id).then(onClose)}>Complete task</button>
              )}
            </div>
          )}
          {event && !isBlock && !readOnly && (
            <button
              type="button"
              className="btn ghost danger"
              onClick={() => {
                const what = g && recurring ? (scope === 'series' ? 'the whole series' : 'this occurrence of') : '';
                if (!confirm(`Delete ${what} "${event.title}"${g ? ' from Google Calendar' : ''}?`)) return;
                void (g ? actions.deleteGoogleEvent(event, recurring ? scope : 'occurrence') : actions.deleteEvent(event.id)).then((r) => r !== undefined && onClose());
              }}
            >
              Delete
            </button>
          )}
          {event && g && (
            <button type="button" className="btn ghost" title="Stop showing this event in the dashboard. Nothing changes in Google."
              onClick={() => void actions.hideGoogleEvent(event).then((r) => r !== undefined && onClose())}>
              Hide here
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
          {!readOnly && (
            <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : event ? 'Save' : 'Add event'}</button>
          )}
        </footer>
      </form>
    </Dialog>
  );
}

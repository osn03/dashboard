// Date rules used everywhere:
//  - Calendar dates ("date-only") are plain 'YYYY-MM-DD' strings and are NEVER
//    converted through a timezone. Arithmetic on them is pure calendar math.
//  - Instants are ISO-8601 UTC strings ('...Z').
//  - Wall-clock times are 'HH:mm' and are only meaningful together with a date
//    and the user's configured IANA timezone.
import { DateTime } from 'luxon';

export type DateStr = string; // YYYY-MM-DD
export type TimeStr = string; // HH:mm
export type Instant = string; // ISO UTC

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(s: string): boolean {
  return DATE_RE.test(s) && DateTime.fromISO(s, { zone: 'utc' }).isValid;
}

export function isValidZone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/** Today's calendar date in the given zone. */
export function todayIn(tz: string, now: Date = new Date()): DateStr {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
}

/** Pure calendar arithmetic; independent of any timezone. */
export function addDays(date: DateStr, days: number): DateStr {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate()!;
}

export function diffDays(from: DateStr, to: DateStr): number {
  const a = DateTime.fromISO(from, { zone: 'utc' });
  const b = DateTime.fromISO(to, { zone: 'utc' });
  return Math.round(b.diff(a, 'days').days);
}

/** ISO weekday 1 (Mon) .. 7 (Sun). */
export function weekdayOf(date: DateStr): number {
  return DateTime.fromISO(date, { zone: 'utc' }).weekday;
}

/** First day of the week containing `date`. weekStart: 1=Mon .. 7=Sun. */
export function startOfWeek(date: DateStr, weekStart: number): DateStr {
  const back = (weekdayOf(date) - weekStart + 7) % 7;
  return addDays(date, -back);
}

export function startOfMonth(date: DateStr): DateStr {
  return date.slice(0, 8) + '01';
}

export function dateRange(from: DateStr, count: number): DateStr[] {
  return Array.from({ length: count }, (_, i) => addDays(from, i));
}

/** Wall-clock date+time in a zone -> UTC instant. Non-existent DST times shift forward. */
export function zonedToInstant(date: DateStr, time: TimeStr, tz: string): Instant {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid date/time: ${date} ${time} (${tz})`);
  return dt.toUTC().toISO()!;
}

export function instantToZoned(instant: Instant, tz: string): { date: DateStr; time: TimeStr } {
  const dt = DateTime.fromISO(instant, { zone: 'utc' }).setZone(tz);
  return { date: dt.toISODate()!, time: dt.toFormat('HH:mm') };
}

/** UTC instants bounding a calendar day in a zone (handles 23h/25h DST days). */
export function dayBounds(date: DateStr, tz: string): { start: Instant; end: Instant } {
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day');
  const end = DateTime.fromISO(addDays(date, 1), { zone: tz }).startOf('day');
  return { start: start.toUTC().toISO()!, end: end.toUTC().toISO()! };
}

export function minutesBetween(a: Instant, b: Instant): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60000);
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  return new Date(Date.parse(instant) + minutes * 60000).toISOString();
}

export function timeToMinutes(t: TimeStr): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

export function minutesToTime(m: number): TimeStr {
  const c = Math.max(0, Math.min(1439, Math.round(m)));
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
}

export function formatTime(instant: Instant, tz: string, hour12: boolean): string {
  const dt = DateTime.fromISO(instant, { zone: 'utc' }).setZone(tz);
  return hour12 ? dt.toFormat('h:mm a') : dt.toFormat('HH:mm');
}

export function formatWallTime(t: TimeStr, hour12: boolean): string {
  if (!hour12) return t;
  return DateTime.fromISO(`2000-01-01T${t}`, { zone: 'utc' }).toFormat('h:mm a');
}

export function formatDate(date: DateStr, style: 'long' | 'short' | 'weekday' | 'month' = 'short'): string {
  const dt = DateTime.fromISO(date, { zone: 'utc' }).setLocale('en-GB');
  if (style === 'long') return dt.toFormat('cccc d LLLL yyyy');
  if (style === 'weekday') return dt.toFormat('ccc d');
  if (style === 'month') return dt.toFormat('LLLL yyyy');
  return dt.toFormat('ccc d LLL');
}

/** Human label relative to today: Today / Tomorrow / Yesterday / Mon 16 Nov. */
export function relativeDate(date: DateStr, today: DateStr): string {
  const d = diffDays(today, date);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  return formatDate(date, 'short') + (date.slice(0, 4) !== today.slice(0, 4) ? ` ${date.slice(0, 4)}` : '');
}

export function formatDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

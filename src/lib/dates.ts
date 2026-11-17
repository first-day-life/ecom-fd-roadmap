// Pure date helpers. All "dates" are 'YYYY-MM-DD' strings and all math is done
// in UTC so results never shift with the viewer's timezone.

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const pad = (n: number) => String(n).padStart(2, '0');

export function toUTC(d: string): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

export function fmt(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function addDays(d: string, n: number): string {
  const x = toUTC(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fmt(x);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86400000);
}

/** 0 = Monday … 6 = Sunday */
export function weekday(d: string): number {
  return (toUTC(d).getUTCDay() + 6) % 7;
}

export function ym(year: number, monthIdx: number): string {
  return `${year}-${pad(monthIdx + 1)}`;
}

export function monthStart(ymStr: string): string {
  return `${ymStr}-01`;
}

export function monthEnd(ymStr: string): string {
  const [y, m] = ymStr.split('-').map(Number);
  return fmt(new Date(Date.UTC(y, m, 0)));
}

export function shiftMonth(ymStr: string, delta: number): string {
  const [y, m] = ymStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return ym(d.getUTCFullYear(), d.getUTCMonth());
}

export function monthLabel(ymStr: string, short = false): string {
  if (!ymStr) return '';
  const [y, m] = ymStr.split('-').map(Number);
  const name = MONTH_NAMES[m - 1] || '';
  return short ? `${name.slice(0, 3)} ${y}` : `${name} ${y}`;
}

export function shortDate(d: string): string {
  if (!d) return '';
  const x = toUTC(d);
  return `${MONTH_NAMES[x.getUTCMonth()].slice(0, 3)} ${x.getUTCDate()}`;
}

/** Monday-start weeks that touch the given month. Each week = 7 consecutive dates. */
export function weeksOfMonth(ymStr: string): string[][] {
  const first = monthStart(ymStr);
  const last = monthEnd(ymStr);
  let cursor = addDays(first, -weekday(first));
  const weeks: string[][] = [];
  while (cursor <= last) {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(cursor, i)));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

export function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Parse a free-form month label into 'YYYY-MM'.
 * Accepts "2026-11", "November 2026", "Nov 2026", "Nov '26", "11/2026", or "November"
 * (no year → fallbackYear).
 */
export function parseMonthLabel(raw: string, fallbackYear: number): string {
  const s = (raw || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(Number(m[2]))}`;
  m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${pad(Number(m[1]))}`;
  const lower = s.toLowerCase();
  const idx = MONTH_NAMES.findIndex(n => lower.startsWith(n.toLowerCase().slice(0, 3)));
  if (idx === -1) return '';
  // "November 2026", "Nov '26", or "Nov 26" (two-digit year, as in ClickUp's "📅 Target Month")
  const yr = s.match(/(\d{4})/) || s.match(/'(\d{2})\b/) || s.match(/^[A-Za-z]+\.?\s+(\d{2})$/);
  const year = yr ? (yr[1].length === 2 ? 2000 + Number(yr[1]) : Number(yr[1])) : fallbackYear;
  return ym(year, idx);
}

/**
 * Pull a date range out of a sprint name that follows the team's convention,
 * e.g. "11: 2/17 - 2/22" or "Sprint 1 | Nov 16 - Nov 22". Returns null if none.
 */
export function parseSprintRange(name: string, year: number): { start: string; end: string } | null {
  if (!name) return null;
  let m = name.match(/(\d{1,2})\/(\d{1,2})\s*[-–]\s*(\d{1,2})\/(\d{1,2})/);
  if (m) {
    const [sm, sd, em, ed] = m.slice(1).map(Number);
    const start = `${year}-${pad(sm)}-${pad(sd)}`;
    const end = `${em < sm ? year + 1 : year}-${pad(em)}-${pad(ed)}`;
    return { start, end };
  }
  m = name.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})\s*[-–]\s*(?:([A-Za-z]{3})[a-z]*\.?\s+)?(\d{1,2})/);
  if (m) {
    const si = MONTH_NAMES.findIndex(n => n.slice(0, 3).toLowerCase() === m![1].toLowerCase());
    const ei = m[3] ? MONTH_NAMES.findIndex(n => n.slice(0, 3).toLowerCase() === m![3].toLowerCase()) : si;
    if (si === -1 || ei === -1) return null;
    const start = `${year}-${pad(si + 1)}-${pad(Number(m[2]))}`;
    const end = `${ei < si ? year + 1 : year}-${pad(ei + 1)}-${pad(Number(m[4]))}`;
    return { start, end };
  }
  return null;
}

/** Monday of the week containing d. */
export function mondayOf(d: string): string {
  return addDays(d, -weekday(d));
}

/** Friday of the week containing d — the app's "end of a planned week". */
export function fridayOf(d: string): string {
  return addDays(mondayOf(d), 4);
}

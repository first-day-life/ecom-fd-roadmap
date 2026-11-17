'use client';

import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react';
import Link from 'next/link';
import { AuthStatus } from '@/components/AuthStatus';
import type { Initiative, InitiativeInput, RoadmapMeta, ListMeta } from '@/lib/types';
import { PRIORITIES } from '@/lib/types';
import {
  addDays, diffDays, monthStart, monthEnd, monthLabel, shiftMonth, shortDate,
  weeksOfMonth, overlaps, todayStr, parseSprintRange, mondayOf, fridayOf,
} from '@/lib/dates';

// ---------------------------------------------------------------------------
// Placement rules
// ---------------------------------------------------------------------------

type Span = { start: string; end: string; source: 'dates' | 'roadmap' | 'sprint' };

/**
 * Where an item sits on the calendar, in priority order:
 *   1. the task's own start/due dates
 *   2. the "Roadmap Start Date" / "Roadmap End Date" fields (only when the task has no start/due date)
 *   3. a date range parsed from the sprint name
 * Items with none of these are unplanned.
 */
function spanOf(i: Initiative): Span | null {
  if (i.startDate || i.dueDate) {
    let s = i.startDate || i.dueDate, e = i.dueDate || i.startDate;
    if (s > e) [s, e] = [e, s];
    return { start: s, end: e, source: 'dates' };
  }
  if (i.roadmapStart || i.roadmapEnd) {
    let s = i.roadmapStart || i.roadmapEnd, e = i.roadmapEnd || i.roadmapStart;
    if (s > e) [s, e] = [e, s];
    return { start: s, end: e, source: 'roadmap' };
  }
  if (i.sprint) {
    const r = parseSprintRange(i.sprint, new Date().getFullYear());
    if (r) return { ...r, source: 'sprint' };
  }
  return null;
}

const SOURCE_LABEL: Record<Span['source'] | 'none', string> = {
  dates: 'Task start/due dates',
  roadmap: 'Roadmap Start/End Date fields (task has no start/due date)',
  sprint: 'Dates parsed from the sprint name',
  none: 'Not on the calendar — no dates set',
};

function sourceOf(i: Initiative): keyof typeof SOURCE_LABEL {
  return spanOf(i)?.source || 'none';
}

function inMonth(i: Initiative, ymStr: string): boolean {
  const sp = spanOf(i);
  return !!sp && overlaps(sp.start, sp.end, monthStart(ymStr), monthEnd(ymStr));
}

/** Roadmap Start/End covering a month's whole weeks (first Monday → last Friday), never starting before this week. */
function monthWeeks(ymStr: string): { roadmapStart: string; roadmapEnd: string } {
  const ms = monthStart(ymStr), me = monthEnd(ymStr);
  let start = mondayOf(ms) < ms ? addDays(mondayOf(ms), 7) : mondayOf(ms);
  const thisWeek = mondayOf(todayStr());
  if (start < thisWeek) start = thisWeek;
  let end = fridayOf(me) > me ? addDays(fridayOf(me), -7) : fridayOf(me);
  if (end < start) end = fridayOf(start);
  return { roadmapStart: start, roadmapEnd: end };
}

function dateRangeLabel(i: Initiative): string {
  const sp = spanOf(i);
  if (!sp) return '';
  return sp.start === sp.end ? shortDate(sp.start) : `${shortDate(sp.start)} – ${shortDate(sp.end)}`;
}

// ---------------------------------------------------------------------------
// Colors: by Pillar when the lists have one, otherwise by ClickUp list
// ---------------------------------------------------------------------------

const FALLBACK_PILLAR_COLORS: Record<string, string> = { CVR: '#4f6ef7', AOV: '#10b981', LTV: '#f59e0b' };
const PRIORITY_COLORS: Record<string, string> = { Urgent: '#dc2626', High: '#ef4444', Normal: '#6b7280', Low: '#9ca3af' };

interface Colors { colorOf: (i: Initiative) => string; groupOf: (i: Initiative) => string; listColor: (id: string) => string; pillarColor: (p: string) => string }
const ColorCtx = createContext<Colors>({ colorOf: () => '#cbd5e1', groupOf: () => '', listColor: () => '#cbd5e1', pillarColor: () => '#cbd5e1' });
const useColors = () => useContext(ColorCtx);

// ---------------------------------------------------------------------------
// Test conflicts — two open test tasks that target the same thing at the same time
// ---------------------------------------------------------------------------

/** A "test" = Task Category "AB Test Launch", or anything in an AB-test list. */
function isTestItem(i: Initiative): boolean {
  return (i.attrs?.['Task Category'] || []).some(c => /ab test launch/i.test(c)) || /a\/?b test/i.test(i.listName);
}

const EVERYTHING = new Set(['sitewide', 'site-wide', 'all', '*', 'global', 'everything']);
const slug = (x: string) => x.trim().replace(/\s+/g, '-');

/**
 * Normalize one target and add path aliases for common shorthand:
 *   "Homepage …" → "/" · "PDP: x" → "/products/x" · "PDP" → "/products"
 *   "Collection: x" / "PLP: x" → "/collections/x" · "LP: x" / "Page: x" → "/pages/x" · "Cart" → "/cart"
 * "~text" means "URL contains text" (from Intelligems 'contains' rules).
 */
function normTargets(raw: string): string[] {
  const t = raw.trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?[^/\s]+/, '')
    .replace(/[?#].*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/(.)\/$/, '$1');
  if (!t) return [];
  const out = new Set([t]);
  let m: RegExpMatchArray | null;
  if (t === '/' || /^(homepage|home page|home)\b/.test(t)) out.add('/');
  if ((m = t.match(/^(pdp|pdps|product|products)\s*[:\-–]\s*(.+)$/))) out.add('/products/' + slug(m[2]));
  else if (/^(pdp|pdps|all pdps|product pages?|products)$/.test(t)) out.add('/products');
  if ((m = t.match(/^(collection|collections|plp)\s*[:\-–]\s*(.+)$/))) out.add('/collections/' + slug(m[2]));
  else if (/^(plp|plps|collections|collection pages?)$/.test(t)) out.add('/collections');
  if ((m = t.match(/^(lp|page|pages|landing page)\s*[:\-–]\s*(.+)$/))) out.add('/pages/' + slug(m[2]));
  if (t === 'cart') out.add('/cart');
  return Array.from(out);
}

/** Split "🧪 Test Targeting" text into normalized targets (comma/semicolon/newline separated). */
function targetsOf(i: Initiative): string[] {
  return Array.from(new Set((i.testTargeting || '').split(/[,;\n]+/).flatMap(normTargets)));
}

/** Targets two sets share: equal, sitewide, URL paths where one contains the other, or "~contains" matches. */
function sharedTargets(a: string[], b: string[]): string[] {
  const out = new Set<string>();
  for (const x of a) for (const y of b) {
    if (x === y) out.add(x);
    else if (EVERYTHING.has(x) || EVERYTHING.has(y)) out.add(EVERYTHING.has(x) ? (EVERYTHING.has(y) ? 'sitewide' : y) : x);
    else if (x.startsWith('~') && !y.startsWith('~') && y.includes(x.slice(1))) out.add(y);
    else if (y.startsWith('~') && !x.startsWith('~') && x.includes(y.slice(1))) out.add(x);
    else if (x.startsWith('/') && y.startsWith('/') && x !== '/' && y !== '/' && (x.startsWith(y + '/') || y.startsWith(x + '/'))) out.add(x.length < y.length ? x : y);
  }
  return Array.from(out).map(t => (t.startsWith('~') ? `URLs containing “${t.slice(1)}”` : t === '/' ? 'homepage (/)' : t));
}

/** Something that occupies a page/area for a period: a ClickUp test task or a live Intelligems test. */
interface TestSlot { id: string; name: string; where: string; kind: 'clickup' | 'intelligems'; targets: string[]; start: string; end: string; url: string }
interface Conflict { other: TestSlot; shared: string[]; from: string; to: string }

/**
 * Live Intelligems tests occupy their pages from launch until Intelligems' estimated end
 * (or 2 weeks from today if there's no estimate), never earlier than today.
 */
function liveSlots(tests: LiveTest[]): TestSlot[] {
  const today = todayStr();
  return tests.filter(t => t.status === 'started' && t.targets?.length).map(t => {
    const start = t.startedAt.slice(0, 10);
    const est = t.estimatedDays?.high ? addDays(start, t.estimatedDays.high) : addDays(today, 14);
    return { id: 'ig:' + t.id, name: t.name, where: 'Live in Intelligems', kind: 'intelligems' as const, targets: t.targets, start, end: est > today ? est : today, url: t.url };
  });
}

function findConflicts(items: Initiative[], live: LiveTest[]): Map<string, Conflict[]> {
  const slots: TestSlot[] = [
    ...items.filter(i => !i.done && isTestItem(i) && targetsOf(i).length && spanOf(i)).map(i => {
      const sp = spanOf(i)!;
      return { id: i.id, name: i.name, where: i.listName, kind: 'clickup' as const, targets: targetsOf(i), start: sp.start, end: sp.end, url: i.url };
    }),
    ...liveSlots(live),
  ];
  const map = new Map<string, Conflict[]>();
  for (let x = 0; x < slots.length; x++) for (let y = x + 1; y < slots.length; y++) {
    const a = slots[x], b = slots[y];
    if (!overlaps(a.start, a.end, b.start, b.end)) continue;
    const shared = sharedTargets(a.targets, b.targets);
    if (!shared.length) continue;
    const from = a.start > b.start ? a.start : b.start;
    const to = a.end < b.end ? a.end : b.end;
    map.set(a.id, [...(map.get(a.id) || []), { other: b, shared, from, to }]);
    map.set(b.id, [...(map.get(b.id) || []), { other: a, shared, from, to }]);
  }
  return map;
}

const ConflictCtx = createContext<Map<string, Conflict[]>>(new Map());
const useConflicts = () => useContext(ConflictCtx);
const conflictText = (cs: Conflict[]) =>
  cs.map(c => `⚠️ Conflicts with ${c.other.kind === 'intelligems' ? 'live test' : ''} “${c.other.name}” on ${c.shared.join(', ')} (${shortDate(c.from)} – ${shortDate(c.to)})`).join('\n');

function ConflictNote({ id }: { id: string }) {
  const cs = useConflicts().get(id);
  if (!cs?.length) return null;
  return <span className="conflict-badge" title={conflictText(cs)}>⚠️ {cs.length} conflict{cs.length > 1 ? 's' : ''}</span>;
}

// ---------------------------------------------------------------------------
// Drag-to-schedule: drop any item chip onto a month, a week or a day
// ---------------------------------------------------------------------------

type Target = { kind: 'day'; date: string } | { kind: 'week'; start: string; end: string } | { kind: 'month'; ym: string };
const ScheduleCtx = createContext<(id: string, t: Target) => void>(() => {});
const DRAG_TYPE = 'text/roadmap-id';

function DropZone({ target, className = '', overClass = 'drop-over', style, children }: {
  target: Target; className?: string; overClass?: string; style?: React.CSSProperties; children?: React.ReactNode;
}) {
  const schedule = useContext(ScheduleCtx);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`${className} ${over ? overClass : ''}`}
      style={style}
      onDragOver={e => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (!over) setOver(true); } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) schedule(id, target);
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

const SPANS = [3, 6, 12] as const;

/** URL state: ?month=YYYY-MM opens a month; otherwise ?from=YYYY-MM&span=3|6|12 sets the overview window. */
function readUrl(): { from: string; span: number; month: string | null } {
  const nowYm = todayStr().slice(0, 7);
  if (typeof window === 'undefined') return { from: nowYm, span: 3, month: null };
  const q = new URLSearchParams(window.location.search);
  const valid = (v: string | null) => (v && /^\d{4}-\d{2}$/.test(v) ? v : null);
  const span = SPANS.includes(Number(q.get('span')) as any) ? Number(q.get('span')) : 3;
  return { from: valid(q.get('from')) || nowYm, span, month: valid(q.get('month')) };
}

function exportCSV(items: Initiative[]) {
  const headers = ['Name', 'List', 'Pillar', 'Status', 'Priority', 'Owner', 'Start', 'Due', 'Roadmap Start', 'Roadmap End', 'Sprint', 'Big Swing', 'ClickUp URL', 'Notes'];
  const rows = items.map(i => [i.name, i.listName, i.pillar, i.status, i.priority, i.owners.map(o => o.name).join('; '), i.startDate, i.dueDate, i.roadmapStart, i.roadmapEnd, i.sprint, i.bigSwing ? 'Yes' : 'No', i.url, i.notes]
    .map(v => `"${String(v || '').replace(/"/g, '""')}"`));
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'firstday_roadmap.csv';
  a.click();
}

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', ...opts?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
  return data as T;
}

/** Mondays from the current week forward ~15 months. A past `current` value stays selectable so it still displays. */
function weekChoices(_around: string, current?: string): string[] {
  const first = mondayOf(todayStr());
  const out: string[] = [];
  for (let i = 0; i < 64; i++) out.push(addDays(first, 7 * i));
  if (current && !out.includes(mondayOf(current))) out.push(mondayOf(current));
  return out.sort();
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function StatusDot({ color, title }: { color: string; title?: string }) {
  return <span className="status-swatch" style={{ background: color }} title={title} />;
}

function Avatars({ owners }: { owners: Initiative['owners'] }) {
  if (!owners.length) return null;
  return (
    <span className="avatars">
      {owners.slice(0, 3).map(o => <span key={o.id} className="avatar" style={{ background: o.color }} title={o.name}>{o.initials}</span>)}
    </span>
  );
}

function ItemChip({ item, onOpen, draggable }: { item: Initiative; onOpen: (id: string) => void; draggable?: boolean }) {
  const { colorOf } = useColors();
  const sp = spanOf(item);
  // Items with their own ClickUp start/due dates are locked — never draggable
  draggable = (draggable ?? true) && sp?.source !== 'dates';
  return (
    <button
      className={`chip ${item.done ? 'chip-done' : ''}`}
      style={{ borderLeftColor: colorOf(item) }}
      onClick={() => onOpen(item.id)}
      draggable={draggable}
      onDragStart={draggable ? e => { e.dataTransfer.setData(DRAG_TYPE, item.id); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      title={`${item.name}\n${item.listName} · ${item.status}\n${SOURCE_LABEL[sourceOf(item)]}`}
    >
      {sp?.source === 'dates' && <span className="bar-lock" title="Dates set on the ClickUp task">🔒</span>}
      <StatusDot color={item.statusColor} />
      <span className="chip-name">{item.name}</span>
      {item.bigSwing && <span className="chip-swing" title="Big Swing">★</span>}
      {sp && <span className={`chip-dates ${sp.source !== 'dates' ? 'chip-dates-soft' : ''}`}>{dateRangeLabel(item)}</span>}
      <Avatars owners={item.owners} />
    </button>
  );
}

function Legend({ meta }: { meta: RoadmapMeta }) {
  const { listColor, pillarColor } = useColors();
  const byPillar = meta.pillars.length > 0;
  return (
    <div className="legend">
      {byPillar
        ? meta.pillars.map(p => <span key={p.id} className="legend-item"><span className="list-dot" style={{ background: pillarColor(p.name) }} />{p.name}</span>)
        : meta.lists.map(l => <span key={l.id} className="legend-item"><span className="list-dot" style={{ background: listColor(l.id) }} />{l.name}</span>)}
      <span className="legend-sep" />
      <span className="legend-item"><span className="legend-bar" /> 🔒 ClickUp task dates (read-only)</span>
      <span className="legend-item"><span className="legend-bar legend-bar-soft" /> Roadmap Start/End (editable)</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview — a rolling window of months starting at the current month
// ---------------------------------------------------------------------------

function OverviewView({ months, items, onOpenMonth, onOpenItem }: {
  months: string[]; items: Initiative[]; onOpenMonth: (ym: string) => void; onOpenItem: (id: string) => void;
}) {
  const { colorOf, groupOf } = useColors();
  const nowYm = todayStr().slice(0, 7);
  const unplanned = items.filter(i => sourceOf(i) === 'none');
  const [showUnplanned, setShowUnplanned] = useState(false);
  // Fewer months on screen → taller cards with more items listed
  const perCard = months.length <= 3 ? 18 : months.length <= 6 ? 10 : 6;
  const cols = months.length <= 3 ? 3 : months.length <= 6 ? 3 : 4;

  return (
    <>
      <div className={`year-grid ${months.length <= 3 ? 'year-grid-wide' : ''}`} style={{ '--cols': cols } as React.CSSProperties}>
        {months.map(key => {
          const monthItems = items.filter(i => inMonth(i, key));
          const done = monthItems.filter(i => i.done).length;
          const pct = monthItems.length ? Math.round((done / monthItems.length) * 100) : 0;
          const groups = new Map<string, { n: number; color: string }>();
          monthItems.forEach(i => {
            const g = groupOf(i) || '—';
            groups.set(g, { n: (groups.get(g)?.n || 0) + 1, color: colorOf(i) });
          });
          const sortKey = (i: Initiative) => spanOf(i)?.start || '9999';
          const sorted = [...monthItems].sort((a, b) => Number(a.done) - Number(b.done) || sortKey(a).localeCompare(sortKey(b)));
          return (
            <DropZone key={key} target={{ kind: 'month', ym: key }} overClass="month-card-drop" className={`month-card ${key === nowYm ? 'month-card-current' : ''}`}>
              <button className="month-card-head" onClick={() => onOpenMonth(key)}>
                <span className="month-card-name">{monthLabel(key)}</span>
                <span className="month-card-count">{monthItems.length}</span>
                {key === nowYm && <span className="week-now">This month</span>}
                <span className="month-card-open">Open month →</span>
              </button>
              <div className="month-card-pillars">
                {Array.from(groups.entries()).map(([g, v]) => (
                  <span key={g} className="pillar-tag" style={{ color: v.color, borderColor: v.color }} title={g}>
                    {g.length > 18 ? g.slice(0, 17) + '…' : g} {v.n}
                  </span>
                ))}
                {monthItems.length > 0 && <span className="month-card-pct">{pct}% done</span>}
              </div>
              <div className="progress-bar-bg" style={{ margin: '8px 0 10px' }}><div className="progress-bar-fill" style={{ width: pct + '%' }} /></div>
              <div className="month-card-items">
                {sorted.slice(0, perCard).map(i => (
                  <button key={i.id} className={`month-card-item ${i.done ? 'is-done' : ''}`} onClick={() => onOpenItem(i.id)} title={`${i.name} · ${i.listName} · ${i.status}`}>
                    <span className="pillar-bar" style={{ background: colorOf(i) }} />
                    <span className="month-card-item-name">{i.name}</span>
                    {i.bigSwing && <span className="chip-swing">★</span>}
                    <span className="month-card-item-date">{dateRangeLabel(i) || 'no date'}</span>
                  </button>
                ))}
                {sorted.length > perCard && <button className="month-card-more" onClick={() => onOpenMonth(key)}>+{sorted.length - perCard} more — open month</button>}
                {sorted.length === 0 && <div className="month-card-empty">Nothing planned yet</div>}
              </div>
            </DropZone>
          );
        })}
      </div>

      {unplanned.length > 0 && (
        <div className="unplanned">
          <button className="unplanned-head" onClick={() => setShowUnplanned(s => !s)}>
            {showUnplanned ? '▾' : '▸'} Unplanned <span className="count-badge">{unplanned.length}</span>
            <span className="unplanned-hint">No dates — open a month and drag these onto a week, or use the Backlog tab</span>
          </button>
          {showUnplanned && <div className="chip-wrap">{unplanned.map(i => <ItemChip key={i.id} item={i} onOpen={onOpenItem} />)}</div>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Month view — weeks are the smallest unit. One column per week, one bar per item.
// Dragging/resizing snaps to whole weeks and writes Roadmap Start (Mon) / End (Fri).
// Items with their own ClickUp start/due dates are shown but locked.
// ---------------------------------------------------------------------------

type DragState = { id: string; mode: 'start' | 'end' | 'move'; startX: number; s0: string; e0: string; dS: number; dE: number; moved: boolean };

function MonthView({ monthKey, items, lists, liveTests, onUpdate, onOpen, onAdd }: {
  monthKey: string; items: Initiative[]; lists: ListMeta[]; liveTests: LiveTest[];
  onUpdate: (id: string, patch: InitiativeInput) => void; onOpen: (id: string) => void;
  onAdd: (defaults: InitiativeInput) => void;
}) {
  const { colorOf, groupOf, listColor } = useColors();
  const conflicts = useConflicts();
  const weeks = useMemo(() => weeksOfMonth(monthKey), [monthKey]);
  const today = todayStr();
  const gridStart = weeks[0][0];
  const gridEnd = weeks[weeks.length - 1][6];
  const nW = weeks.length;
  const weekIdx = (d: string) => Math.max(0, Math.min(nW - 1, Math.floor(diffDays(gridStart, d) / 7)));

  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const [tray, setTray] = useState<'unplanned' | 'all'>('unplanned');
  const [trayQuery, setTrayQuery] = useState('');
  const [trayList, setTrayList] = useState('');
  const [trayOpenOnly, setTrayOpenOnly] = useState(true);
  const [groupByList, setGroupByList] = useState(true);

  const monthItems = items.filter(i => inMonth(i, monthKey));
  const dated = monthItems.filter(i => { const sp = spanOf(i); return sp && overlaps(sp.start, sp.end, gridStart, gridEnd); });
  const liveInMonth = liveSlots(liveTests).filter(s => overlaps(s.start, s.end, gridStart, gridEnd));
  const unplanned = items.filter(i => sourceOf(i) === 'none' && !i.done);
  const traySource = tray === 'unplanned' ? unplanned : items.filter(i => !trayOpenOnly || !i.done);
  const trayItems = traySource
    .filter(i => !trayList || i.listId === trayList)
    .filter(i => !trayQuery || i.name.toLowerCase().includes(trayQuery.toLowerCase()))
    .sort(makeSorter('smart', lists));

  // Preview of a bar while dragging, in whole weeks
  const preview = (i: Initiative) => {
    const sp = spanOf(i)!;
    if (drag?.id !== i.id) return { s: sp.start, e: sp.end };
    return { s: addDays(mondayOf(drag.s0), 7 * drag.dS), e: addDays(fridayOf(drag.e0), 7 * drag.dE) };
  };

  const begin = (e: React.PointerEvent, item: Initiative, mode: DragState['mode']) => {
    const sp = spanOf(item);
    if (!sp || sp.source === 'dates' || e.button !== 0) { if (e.button === 0) onOpen(item.id); return; }
    e.preventDefault();
    e.stopPropagation();
    const st: DragState = { id: item.id, mode, startX: e.clientX, s0: sp.start, e0: sp.end, dS: 0, dE: 0, moved: false };
    dragRef.current = st;
    setDrag(st);
    const weeksSpan = Math.round(diffDays(mondayOf(sp.start), mondayOf(sp.end)) / 7);

    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur || !gridRef.current) return;
      const colW = gridRef.current.getBoundingClientRect().width / nW;
      const delta = Math.round((ev.clientX - cur.startX) / colW);
      let dS = 0, dE = 0;
      if (cur.mode === 'move') { dS = delta; dE = delta; }
      if (cur.mode === 'start') dS = Math.min(delta, weeksSpan);   // start can't pass the end week
      if (cur.mode === 'end') dE = Math.max(delta, -weeksSpan);    // end can't pass the start week
      const next = { ...cur, dS, dE, moved: cur.moved || Math.abs(ev.clientX - cur.startX) > 3 };
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!cur) return;
      if (!cur.moved && cur.mode === 'move') { onOpen(cur.id); return; }
      const start = addDays(mondayOf(cur.s0), 7 * cur.dS);
      const end = addDays(fridayOf(cur.e0), 7 * cur.dE);
      if (start !== cur.s0 || end !== cur.e0) onUpdate(cur.id, { roadmapStart: start, roadmapEnd: end });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Rows: optionally grouped by list
  type Row = { kind: 'group'; label: string; color: string; n: number } | { kind: 'item'; item: Initiative } | { kind: 'live'; slot: TestSlot };
  const sortKey = (i: Initiative) => spanOf(i)!.start;
  const rows: Row[] = [];
  if (groupByList) {
    for (const l of lists) {
      const its = dated.filter(i => i.listId === l.id).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
      if (!its.length) continue;
      rows.push({ kind: 'group', label: l.name, color: listColor(l.id), n: its.length });
      its.forEach(item => rows.push({ kind: 'item', item }));
    }
  } else {
    [...dated].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).forEach(item => rows.push({ kind: 'item', item }));
  }
  if (liveInMonth.length) {
    rows.push({ kind: 'group', label: '🧪 Live in Intelligems', color: '#ef4444', n: liveInMonth.length });
    liveInMonth.sort((a, b) => a.start.localeCompare(b.start)).forEach(slot => rows.push({ kind: 'live', slot }));
  }

  const done = monthItems.filter(i => i.done).length;
  const groups = new Map<string, { n: number; color: string }>();
  monthItems.forEach(i => { const g = groupOf(i) || '—'; groups.set(g, { n: (groups.get(g)?.n || 0) + 1, color: colorOf(i) }); });
  const cols = `repeat(${nW}, minmax(150px, 1fr))`;

  return (
    <div className="month-layout">
      <div className="month-view">
        {(() => {
          const ids: Array<{ id: string; name: string }> = [
            ...monthItems.filter(i => conflicts.has(i.id)).map(i => ({ id: i.id, name: i.name })),
            ...liveInMonth.filter(sl => conflicts.has(sl.id)).map(sl => ({ id: sl.id, name: sl.name })),
          ];
          if (!ids.length) return null;
          const seen = new Set<string>();
          const pairs: string[] = [];
          ids.forEach(x => conflicts.get(x.id)!.forEach(c => {
            if (!overlaps(c.from, c.to, gridStart, gridEnd)) return;
            const k = [x.id, c.other.id].sort().join('|');
            if (seen.has(k)) return; seen.add(k);
            pairs.push(`“${x.name}” ↔ ${c.other.kind === 'intelligems' ? '🔴 ' : ''}“${c.other.name}” on ${c.shared.join(', ')} (${shortDate(c.from)} – ${shortDate(c.to)})`);
          }));
          if (!pairs.length) return null;
          return (
            <div className="conflict-banner">
              <strong>⚠️ {pairs.length} test conflict{pairs.length > 1 ? 's' : ''} this month</strong> — tests targeting the same page/area overlap:
              <ul>{pairs.map(p => <li key={p}>{p}</li>)}</ul>
            </div>
          );
        })()}
        <div className="month-view-tools">
          <label className="tray-check"><input type="checkbox" checked={groupByList} onChange={e => setGroupByList(e.target.checked)} /> Group by list</label>
          <span className="month-view-hint">Drag a bar to move it by week · drag its edges to add or remove weeks · drop items from the sidebar onto a week · 🔒 = dates set on the ClickUp task (change them in ClickUp)</span>
        </div>

        <div className="gantt">
          <div className="gantt-head" style={{ gridTemplateColumns: cols }}>
            {weeks.map((days, wi) => {
              const isCurrent = days[0] <= today && today <= days[6];
              return (
                <DropZone key={days[0]} target={{ kind: 'week', start: days[0], end: days[4] }} overClass="week-drop"
                  className={`gantt-week ${isCurrent ? 'gantt-week-current' : ''} ${days[6] < today ? 'gantt-week-past' : ''}`}>
                  <div className="gantt-week-title">Week {wi + 1}{isCurrent && <span className="week-now">Now</span>}</div>
                  <div className="gantt-week-range">{shortDate(days[0])} – {shortDate(days[4])}</div>
                </DropZone>
              );
            })}
          </div>

          <div className="gantt-body" ref={gridRef} style={{ gridTemplateColumns: cols }}>
            {weeks.map((days, wi) => (
              <DropZone key={days[0]} target={{ kind: 'week', start: days[0], end: days[4] }} overClass="week-drop"
                className={`gantt-col ${days[0] <= today && today <= days[6] ? 'gantt-col-current' : ''}`}
                style={{ gridColumn: wi + 1, gridRow: `1 / span ${Math.max(rows.length, 1) + 1}` }} />
            ))}
            {rows.length === 0 && (
              <div className="week-empty" style={{ gridColumn: `1 / ${nW + 1}`, gridRow: 1 }}>
                Nothing scheduled this month yet — drag items from the sidebar onto a week.
              </div>
            )}
            {rows.map((r, idx) => {
              if (r.kind === 'group') {
                return (
                  <div key={'g' + r.label} className="gantt-group" style={{ gridColumn: `1 / ${nW + 1}`, gridRow: idx + 1 }}>
                    <span className="list-dot" style={{ background: r.color }} />{r.label}<span className="count-badge">{r.n}</span>
                  </div>
                );
              }
              if (r.kind === 'live') {
                const sl = r.slot;
                const a = weekIdx(sl.start < gridStart ? gridStart : sl.start);
                const b = weekIdx(sl.end > gridEnd ? gridEnd : sl.end);
                const cs = conflicts.get(sl.id);
                return (
                  <a key={sl.id} href={sl.url || undefined} target="_blank" rel="noreferrer"
                    className={`bar bar-live ${sl.start < gridStart ? 'clip-l' : ''} ${sl.end > gridEnd ? 'clip-r' : ''} ${cs ? 'bar-conflict' : ''}`}
                    style={{ gridColumn: `${a + 1} / ${b + 2}`, gridRow: idx + 1, '--bar': '#ef4444' } as React.CSSProperties}
                    title={`🧪 Live Intelligems test: ${sl.name}\nLive since ${shortDate(sl.start)} · shown through ${shortDate(sl.end)} (estimated)\n🎯 ${sl.targets.join(', ')}${cs ? '\n' + conflictText(cs) : ''}\nClick to open in Intelligems`}>
                    {sl.start < gridStart && <span className="bar-arrow">‹</span>}
                    {cs && <span className="bar-lock">⚠️</span>}
                    <span className="bar-lock">🔴</span>
                    <span className="bar-name">{sl.name}</span>
                    {sl.end > gridEnd && <span className="bar-arrow">›</span>}
                  </a>
                );
              }
              const item = r.item;
              const src = spanOf(item)!.source;
              const locked = src === 'dates';
              const { s, e } = preview(item);
              const a = weekIdx(s < gridStart ? gridStart : s);
              const b = weekIdx(e > gridEnd ? gridEnd : e);
              const clipL = s < gridStart;
              const clipR = e > gridEnd;
              const active = drag?.id === item.id;
              return (
                <div
                  key={item.id}
                  className={`bar ${item.done ? 'bar-done' : ''} ${active ? 'bar-active' : ''} ${locked ? 'bar-locked' : 'bar-soft'} ${clipL ? 'clip-l' : ''} ${clipR ? 'clip-r' : ''} ${conflicts.has(item.id) ? 'bar-conflict' : ''}`}
                  style={{ gridColumn: `${a + 1} / ${b + 2}`, gridRow: idx + 1, '--bar': colorOf(item) } as React.CSSProperties}
                  onPointerDown={ev => begin(ev, item, 'move')}
                  title={`${item.name} · ${item.listName} · ${item.status}\n${shortDate(s)} – ${shortDate(e)}${item.testTargeting ? `\n🧪 Targets: ${item.testTargeting}` : ''}\n${locked ? '🔒 Dates come from the ClickUp task’s start/due date — change them in ClickUp.' : 'Roadmap dates · drag to move by week, drag edges to resize'}${conflicts.has(item.id) ? '\n' + conflictText(conflicts.get(item.id)!) : ''}`}
                >
                  {!clipL && !locked && <span className="bar-handle bar-handle-l" onPointerDown={ev => begin(ev, item, 'start')} />}
                  {clipL && <span className="bar-arrow">‹</span>}
                  {locked && <span className="bar-lock">🔒</span>}
                  {conflicts.has(item.id) && <span className="bar-lock" title={conflictText(conflicts.get(item.id)!)}>⚠️</span>}
                  {isTestItem(item) && !conflicts.has(item.id) && <span className="bar-lock" title={item.testTargeting ? `🧪 Targets: ${item.testTargeting}` : '🧪 A/B test — add Test Targeting in ClickUp to check for conflicts'}>🧪</span>}
                  <StatusDot color={item.statusColor} />
                  <span className="bar-name">{item.name}</span>
                  {item.bigSwing && <span className="chip-swing">★</span>}
                  <span className="bar-dates">{active ? `${shortDate(s)} – ${shortDate(e)}` : ''}</span>
                  <Avatars owners={item.owners} />
                  {clipR && <span className="bar-arrow">›</span>}
                  {!clipR && !locked && <span className="bar-handle bar-handle-r" onPointerDown={ev => begin(ev, item, 'end')} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <aside className="month-side">
        <div className="side-card">
          <div className="side-title">{monthLabel(monthKey)}</div>
          <div className="side-stats">
            <div><strong>{monthItems.length}</strong><span>items</span></div>
            <div><strong>{dated.length}</strong><span>scheduled</span></div>
            <div><strong>{monthItems.length ? Math.round((done / monthItems.length) * 100) : 0}%</strong><span>done</span></div>
          </div>
          <div className="side-groups">
            {Array.from(groups.entries()).map(([g, v]) => (
              <div key={g} className="side-group"><span className="list-dot" style={{ background: v.color }} /><span className="side-group-name">{g}</span><span className="side-group-n">{v.n}</span></div>
            ))}
          </div>
        </div>

        <div className="side-card side-tray">
          <div className="view-toggle tray-tabs">
            <button className={tray === 'unplanned' ? 'active' : ''} onClick={() => setTray('unplanned')} title="Open tasks with no dates">Unplanned <span className="count-badge">{unplanned.length}</span></button>
            <button className={tray === 'all' ? 'active' : ''} onClick={() => setTray('all')} title="Every task in every list">All</button>
          </div>
          <div className="tray-filters">
            <input className="filter-input tray-search" placeholder="Search…" value={trayQuery} onChange={e => setTrayQuery(e.target.value)} />
            <select className="filter-select" value={trayList} onChange={e => setTrayList(e.target.value)}>
              <option value="">All lists</option>
              {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {tray === 'all' && <label className="tray-check"><input type="checkbox" checked={trayOpenOnly} onChange={e => setTrayOpenOnly(e.target.checked)} /> Open only</label>}
          </div>
          <p className="month-only-hint" style={{ marginTop: 0 }}>Drag onto a <strong>week</strong> to set Roadmap Start (Mon) and End (Fri). Items already on the roadmap keep their length in weeks.</p>
          <div className="tray-list">
            {trayItems.length
              ? trayItems.map(i => <ItemChip key={i.id} item={i} onOpen={onOpen} draggable={sourceOf(i) !== 'dates'} />)
              : <div className="month-card-empty">{trayQuery ? 'No matches' : 'Nothing here.'}</div>}
          </div>
          <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => onAdd(monthWeeks(monthKey))}>+ Add to {monthLabel(monthKey).split(' ')[0]}</button>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backlog — every item in every list, with month drop targets
// ---------------------------------------------------------------------------

function placementLabel(i: Initiative): string {
  const src = sourceOf(i);
  if (src === 'none') return 'Unplanned';
  return dateRangeLabel(i) + (src === 'roadmap' ? ' · roadmap' : src === 'sprint' ? ' · sprint' : ' · ClickUp dates');
}

/** Emoji per filterable field, so the filter bar and card chips are quick to scan. */
const FIELD_EMOJI: Record<string, string> = {
  'ROCK': '🪨', 'TACTIC': '🎯', 'Task Category': '🗂️', 'Type of Request': '📨', 'Ready to Start?': '🚦',
  'Project Owner': '🧑‍💼', 'Experiment Type': '🧪', 'Size': '📏', 'Impact': '💥', 'Complexity': '🧩',
};
const fieldEmoji = (label: string) => FIELD_EMOJI[label] || '🏷️';

// ---------------------------------------------------------------------------
// Sorting — "Highest priority first" is the default everywhere items are listed
// ---------------------------------------------------------------------------

type SortKey = 'smart' | 'status' | 'date' | 'newest' | 'oldest' | 'name';
const SORT_LABELS: Record<SortKey, string> = {
  smart: '🔥 Highest priority first',
  status: '📍 Furthest along first',
  date: '📅 Soonest scheduled',
  newest: '🆕 Newest created',
  oldest: '🕰️ Oldest created',
  name: '🔤 A → Z',
};
const PRIORITY_RANK: Record<string, number> = { Urgent: 0, High: 1, Normal: 2, Low: 3 };
const READY_RANK: Record<string, number> = { 'ready': 0, 'in progress': 1, 'not ready to start': 3 };
const SIZE_RANK: Record<string, number> = { XL: 0, L: 1, M: 2, S: 3, XS: 4 };

/**
 * Builds a comparator. "smart" (default) orders, within each list:
 *   1. open before done
 *   2. ClickUp priority: Urgent → High → Normal → Low → none
 *   3. furthest-along status (e.g. qa / in-progress before to do / backlog)
 *   4. 🚦 Ready to Start?: Ready → in progress → unset → Not Ready
 *   5. 💥 Impact: XL → XS (Idea Parking Lot)
 *   6. has a 🪨 ROCK before no ROCK
 *   7. soonest on the roadmap, then newest created
 */
function makeSorter(sort: SortKey, lists: ListMeta[]) {
  const statusIdx = (i: Initiative) => {
    const l = lists.find(x => x.id === i.listId);
    const idx = l ? l.statuses.findIndex(s => s.name === i.status) : -1;
    return idx < 0 ? 0 : idx;
  };
  const when = (i: Initiative) => spanOf(i)?.start || '9999-99';
  const pri = (i: Initiative) => PRIORITY_RANK[i.priority] ?? 4;
  const ready = (i: Initiative) => READY_RANK[(i.attrs?.['Ready to Start?']?.[0] || '').toLowerCase()] ?? 2;
  const impact = (i: Initiative) => SIZE_RANK[i.attrs?.['Impact']?.[0] || ''] ?? 5;
  const rock = (i: Initiative) => (i.attrs?.['ROCK']?.length ? 0 : 1);
  const created = (i: Initiative) => i.createdAt || '';

  return (a: Initiative, b: Initiative): number => {
    const done = Number(a.done) - Number(b.done);
    switch (sort) {
      case 'name': return a.name.localeCompare(b.name);
      case 'newest': return done || created(b).localeCompare(created(a));
      case 'oldest': return done || created(a).localeCompare(created(b));
      case 'date': return done || when(a).localeCompare(when(b)) || pri(a) - pri(b);
      case 'status': return done || statusIdx(b) - statusIdx(a) || pri(a) - pri(b);
      default:
        return done
          || pri(a) - pri(b)
          || statusIdx(b) - statusIdx(a)
          || ready(a) - ready(b)
          || impact(a) - impact(b)
          || rock(a) - rock(b)
          || when(a).localeCompare(when(b))
          || created(b).localeCompare(created(a));
    }
  };
}

const PRIORITY_FLAG: Record<string, string> = { Urgent: '🔴', High: '🟠', Normal: '🔵', Low: '⚪' };

function PriorityPill({ p }: { p: string }) {
  if (!p) return <span className="prio prio-none" title="No priority set in ClickUp">— no priority</span>;
  return <span className={`prio prio-${p.toLowerCase()}`} title={`ClickUp priority: ${p}`}>{PRIORITY_FLAG[p]} {p}</span>;
}

const SORT_KEY = 'roadmap.backlog.sort';
const COLLAPSE_KEY = 'roadmap.backlog.collapsed';
const CARD_ATTRS = ['ROCK', 'TACTIC', 'Task Category'];   // shown as chips on backlog cards

function BacklogView({ items, meta, onOpen, onSchedule }: {
  items: Initiative[]; meta: RoadmapMeta; onOpen: (id: string) => void; onSchedule: (id: string, t: Target) => void;
}) {
  const { listColor } = useColors();
  const lists = meta.lists;
  const nowYm = todayStr().slice(0, 7);
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(nowYm, i));
  const [show, setShow] = useState<'unplanned' | 'open' | 'all'>('open');
  const [sort, setSortState] = useState<SortKey>('smart');
  useEffect(() => {
    try { const v = localStorage.getItem(SORT_KEY) as SortKey | null; if (v && v in SORT_LABELS) setSortState(v); } catch { /* ignore */ }
  }, []);
  const setSort = (v: SortKey) => { setSortState(v); try { localStorage.setItem(SORT_KEY, v); } catch { /* ignore */ } };
  const sorter = useMemo(() => makeSorter(sort, lists), [sort, lists]);

  // Collapsed columns — Current Sprint starts collapsed; choice remembered per browser
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(lists.filter(l => /current sprint/i.test(l.name)).map(l => l.id)));
  useEffect(() => {
    try { const saved = localStorage.getItem(COLLAPSE_KEY); if (saved) setCollapsed(new Set(JSON.parse(saved))); } catch { /* storage unavailable */ }
  }, []);
  const toggleCol = (id: string) => setCollapsed(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(Array.from(n))); } catch { /* ignore */ }
    return n;
  });
  const optColor = (label: string, name: string) => meta.filterFields.find(f => f.label === label)?.options.find(o => o.name === name)?.color || '#9ca3af';

  const visible = items.filter(i => {
    if (show === 'unplanned' && sourceOf(i) !== 'none') return false;
    if (show !== 'all' && i.done) return false;
    return true;
  });

  return (
    <div className="backlog">
      <div className="month-strip">
        {months.map(m => {
          const n = items.filter(i => inMonth(i, m)).length;
          return (
            <DropZone key={m} target={{ kind: 'month', ym: m }} className={`month-drop ${m === nowYm ? 'month-drop-current' : ''}`} overClass="month-drop-over">
              <strong>{monthLabel(m, true)}</strong>
              <span>{n} item{n === 1 ? '' : 's'}</span>
            </DropZone>
          );
        })}
      </div>
      <p className="month-only-hint" style={{ margin: '0 0 12px' }}>
        Drag a card onto a month to plan it there (sets Roadmap Start/End across that month’s weeks, or moves an already-planned item to the month’s first week),
        or use “Plan for…”. Then open the month and drag it onto a specific week. 🔒 items have their own ClickUp dates and can’t be moved here.
      </p>

      <div className="backlog-tools">
        <div className="view-toggle" style={{ marginLeft: 0 }}>
          <button className={show === 'unplanned' ? 'active' : ''} onClick={() => setShow('unplanned')}>Unplanned</button>
          <button className={show === 'open' ? 'active' : ''} onClick={() => setShow('open')}>All open</button>
          <button className={show === 'all' ? 'active' : ''} onClick={() => setShow('all')}>Everything</button>
        </div>
        <select className={`filter-select ${sort !== 'smart' ? 'filter-on' : ''}`} value={sort} onChange={e => setSort(e.target.value as SortKey)} title="Sort cards within each list"
          style={{ width: 'auto', maxWidth: 'none' }}>
          {(Object.keys(SORT_LABELS) as SortKey[]).map(k => <option key={k} value={k}>Sort: {SORT_LABELS[k]}</option>)}
        </select>
        <span className="month-window-range">{visible.length} items</span>
        <span className="month-only-hint" style={{ margin: 0 }}>Narrow down with 🪨 ROCK, 🎯 TACTIC, 🗂️ Task Category, 📍 status and more above — pick a 📋 list to see only its filters. Click a column header to collapse it.</span>
      </div>

      <div className="backlog-cols">
        {lists.map(l => {
          const colItems = visible.filter(i => i.listId === l.id).sort(sorter);
          if (collapsed.has(l.id)) {
            return (
              <button key={l.id} className="backlog-col backlog-col-collapsed" onClick={() => toggleCol(l.id)} title={`Expand ${l.name}`}>
                <span className="list-dot" style={{ background: listColor(l.id) }} />
                <span className="count-badge">{colItems.length}</span>
                <span className="backlog-col-vertical">{l.name}</span>
              </button>
            );
          }
          return (
            <section key={l.id} className="backlog-col">
              <button className="backlog-col-head" onClick={() => toggleCol(l.id)} title="Collapse column">
                <span className="list-dot" style={{ background: listColor(l.id) }} />
                <span className="backlog-col-name">{l.name}</span>
                <span className="count-badge">{colItems.length}</span>
                <span className="backlog-col-caret">⟨</span>
              </button>
              <div className="backlog-col-body">
                {colItems.map(i => (
                  <div
                    key={i.id}
                    className={`backlog-card ${i.done ? 'chip-done' : ''} ${sourceOf(i) === 'dates' ? 'backlog-locked' : ''}`}
                    draggable={sourceOf(i) !== 'dates'}
                    onDragStart={e => { e.dataTransfer.setData(DRAG_TYPE, i.id); e.dataTransfer.effectAllowed = 'move'; }}
                  >
                    <button className="backlog-card-name" onClick={() => onOpen(i.id)} title={i.name}>{i.name}</button>
                    <div className="backlog-card-meta">
                      <PriorityPill p={i.priority} />
                      <span className="status-text"><StatusDot color={i.statusColor} /> {i.status}</span>
                      <span className={`backlog-place ${sourceOf(i) === 'none' ? 'is-unplanned' : ''}`}>{placementLabel(i)}</span>
                      <Avatars owners={i.owners} />
                    </div>
                    {(i.testTargeting || isTestItem(i)) && (
                      <div className="backlog-attrs">
                        <span className={`attr-chip tt-chip ${i.testTargeting ? '' : 'tt-missing'}`} title={i.testTargeting ? `Test Targeting: ${i.testTargeting}` : 'A/B test with no Test Targeting — add it in ClickUp or the edit panel'}>
                          <em>🧪</em>{i.testTargeting || 'no targeting set'}
                        </span>
                        <ConflictNote id={i.id} />
                      </div>
                    )}
                    {CARD_ATTRS.some(a => i.attrs?.[a]?.length) && (
                      <div className="backlog-attrs">
                        {CARD_ATTRS.flatMap(a => (i.attrs?.[a] || []).map(v => (
                          <span key={a + v} className="attr-chip" style={{ '--c': optColor(a, v) } as React.CSSProperties} title={`${a}: ${v}`}>
                            <em>{fieldEmoji(a)}</em>{v}
                          </span>
                        )))}
                      </div>
                    )}
                    {sourceOf(i) === 'dates'
                      ? <div className="backlog-locked-note">🔒 Dated in ClickUp</div>
                      : <select
                      className="backlog-plan"
                      value=""
                      onChange={e => e.target.value && onSchedule(i.id, { kind: 'month', ym: e.target.value })}
                      title="Plan for a month"
                    >
                      <option value="">Plan for…</option>
                      {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                    </select>}
                  </div>
                ))}
                {colItems.length === 0 && <div className="month-card-empty">Nothing here</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live Intelligems tests — how long each A/B test has been running (read-only)
// ---------------------------------------------------------------------------

type TMetric = { value: number | null; uplift: number | null; p2bc: number | null; sig: 'win' | 'lose' | null; daysToSig: number | null };
interface TestResults {
  call: 'winner' | 'loser' | 'mixed' | 'not_ready' | 'no_data';
  headline: string; reasons: string[]; etaDays: number | null; igVerdict: string | null; estMonthlyImpact: number | null; error?: string;
  variants: Array<{ name: string; isControl: boolean; orders: number; ordersPerDay: number; daysTo300: number | null; metrics: Partial<Record<'rpv' | 'aov' | 'cvr', TMetric>> }>;
}
interface LiveTest {
  id: string; name: string; status: 'started' | 'paused'; type: string; typeLabel: string;
  startedAt: string; pausedAt: string; daysRunning: number; url: string; targets: string[];
  variations: Array<{ name: string; percentage: number; isControl: boolean }>;
  estimatedDays: { low: number | null; high: number | null } | null;
  results: TestResults | null;
}

const IG_VERDICT: Record<string, string> = {
  strong_win: 'strong win', directional_win: 'directional win', directional_loss: 'directional loss', strong_loss: 'strong loss',
  mixed_signals: 'mixed signals', not_ready: 'not ready', error: 'error',
};

function ResultsBlock({ r }: { r: TestResults }) {
  if (r.error) return <div className="test-result res-none">Results unavailable: {r.error}</div>;
  const control = r.variants.find(v => v.isControl);
  const challengers = r.variants.filter(v => !v.isControl);
  const fmtUp = (u: number | null) => (u == null ? '—' : `${u >= 0 ? '+' : ''}${(u * 100).toFixed(1)}%`);
  const fmtP = (p: number | null) => (p == null ? '—' : `${(p * 100).toFixed(p > 0.99 || p < 0.01 ? 1 : 0)}%`);
  return (
    <div className={`test-result res-${r.call}`}>
      <div className="res-headline">{r.headline}</div>
      {challengers.map(v => (
        <div key={v.name} className="res-variant">
          <table className="res-table">
            <thead><tr><th>{challengers.length > 1 ? v.name : 'Variant vs control'}</th><th>Lift</th><th title="Chance the variant beats control">Chance to beat</th><th title="Reached 95%, or estimated days until it could">95%?</th></tr></thead>
            <tbody>
              {(['rpv', 'aov', 'cvr'] as const).map(k => {
                const m = v.metrics[k];
                if (!m) return null;
                return (
                  <tr key={k} className={m.sig ? `sig-${m.sig}` : ''}>
                    <td>{k.toUpperCase()}</td>
                    <td>{fmtUp(m.uplift)}</td>
                    <td>{fmtP(m.p2bc)}</td>
                    <td className="res-nowrap">{m.sig === 'win' ? '✅ better' : m.sig === 'lose' ? '❌ worse' : m.daysToSig ? (m.daysToSig > 180 ? '>6 mo' : `~${m.daysToSig}d`) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="res-orders">
            {[v, ...(control ? [control] : [])].map(x => (
              <div key={x.name} className="res-order-row">
                <span>{x.isControl ? 'Control' : 'Variant'} orders</span>
                <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: Math.min(100, (x.orders / 300) * 100) + '%', background: x.orders >= 300 ? undefined : '#f59e0b' }} /></div>
                <strong>{x.orders.toLocaleString()}</strong><span className="res-dim">/ 300 · {x.ordersPerDay}/day</span>
              </div>
            ))}
          </div>
        </div>
      ))}
      <ul className="res-reasons">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <div className="res-foot">
        {r.igVerdict && <span>Intelligems’ own read: <strong>{IG_VERDICT[r.igVerdict] || r.igVerdict.replace(/_/g, ' ')}</strong></span>}
        {r.estMonthlyImpact != null && <span>Est. monthly impact: <strong className={r.estMonthlyImpact < 0 ? 'neg' : 'pos'}>{r.estMonthlyImpact < 0 ? '−' : '+'}${Math.abs(Math.round(r.estMonthlyImpact)).toLocaleString()}</strong></span>}
      </div>
    </div>
  );
}

/** Age bands for a running test: fresh < 14d, maturing < 28d, long-running ≥ 28d. */
function ageBand(t: LiveTest): 'fresh' | 'mid' | 'long' | 'over' {
  const hi = t.estimatedDays?.high;
  if (hi && t.daysRunning > hi) return 'over';
  if (t.daysRunning >= 28) return 'long';
  if (t.daysRunning >= 14) return 'mid';
  return 'fresh';
}

function TestsView({ data }: { data: { configured: boolean; tests: LiveTest[]; error?: string } | null }) {
  const conflicts = useConflicts();

  if (!data) return <div className="loading-screen" style={{ minHeight: '30vh' }}><div className="spinner" /></div>;
  if (!data.configured) {
    return (
      <div className="tests-empty">
        <h3>🧪 Connect Intelligems</h3>
        <p>Add an Intelligems API key to show live A/B tests here. In Intelligems go to <strong>Integrations → Intelligems External API → Enable</strong>, copy the key, and set it as <code>INTELLIGEMS_API_KEY</code> in Netlify’s environment variables (then redeploy). The roadmap only reads tests — it never changes them.</p>
      </div>
    );
  }
  if (data.error) return <div className="error-banner"><span>⚠</span> Couldn’t load Intelligems tests: {data.error}</div>;

  const live = data.tests.filter(t => t.status === 'started');
  const paused = data.tests.filter(t => t.status === 'paused');
  const avg = live.length ? Math.round(live.reduce((n, t) => n + t.daysRunning, 0) / live.length) : 0;
  const longest = live[0];

  const Card = ({ t }: { t: LiveTest }) => {
    const band = ageBand(t);
    const est = t.estimatedDays;
    const pct = est?.high ? Math.min(100, Math.round((t.daysRunning / est.high) * 100)) : null;
    return (
      <div className={`test-card band-${band} ${t.status === 'paused' ? 'test-paused' : ''}`}>
        <div className="test-days">
          <strong>{t.daysRunning}</strong>
          <span>day{t.daysRunning === 1 ? '' : 's'}{t.status === 'paused' ? ' (paused)' : ' running'}</span>
        </div>
        <div className="test-main">
          <div className="test-name" title={t.name}>{t.name}</div>
          <div className="test-meta">
            <span className="test-type">{t.typeLabel}</span>
            <span>Started {new Date(t.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            {t.pausedAt && <span>· Paused {new Date(t.pausedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
            {band === 'over' && <span className="test-flag">⏰ Past estimated length</span>}
            {band === 'long' && <span className="test-flag">⏳ 4+ weeks — time to call it?</span>}
            {t.url && <a className="test-link" href={t.url} target="_blank" rel="noreferrer">Open in Intelligems ↗</a>}
          </div>
          {est && (est.low || est.high) && (
            <div className="test-est">
              <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: (pct ?? 0) + '%', background: band === 'over' ? '#ef4444' : undefined }} /></div>
              <span>Estimated length {est.low ?? '?'}–{est.high ?? '?'} days</span>
            </div>
          )}
          <div className="test-vars">
            {t.variations.map(v => <span key={v.name} className={`test-var ${v.isControl ? 'is-control' : ''}`}>{v.isControl ? '🅰️' : '🅱️'} {v.name} · {v.percentage}%</span>)}
          </div>
          {t.targets?.length > 0 && (
            <div className="test-targets">
              <em>🎯 Targets</em>
              {t.targets.slice(0, 6).map(x => <span key={x} className="test-var">{x.startsWith('~') ? `URL contains “${x.slice(1)}”` : x === '/' ? 'homepage (/)' : x}</span>)}
              {t.targets.length > 6 && <span className="res-dim">+{t.targets.length - 6} more</span>}
            </div>
          )}
          {(conflicts.get('ig:' + t.id) || []).length > 0 && (
            <div className="conflict-banner">
              <strong>⚠️ Overlaps</strong>
              <ul>{conflicts.get('ig:' + t.id)!.map(c => <li key={c.other.id}>{c.other.kind === 'intelligems' ? 'Live test' : `Planned in ${c.other.where}`}: “{c.other.name}” on {c.shared.join(', ')} ({shortDate(c.from)} – {shortDate(c.to)})</li>)}</ul>
            </div>
          )}
          {t.results && <ResultsBlock r={t.results} />}
        </div>
      </div>
    );
  };

  return (
    <div className="tests-view">
      <div className="side-stats tests-stats">
        <div><strong>{live.length}</strong><span>live tests</span></div>
        <div><strong>{avg}</strong><span>avg days running</span></div>
        <div><strong>{longest ? longest.daysRunning : 0}</strong><span>longest (days)</span></div>
        <div><strong>{live.filter(t => t.results && ['winner', 'loser', 'mixed'].includes(t.results.call)).length}</strong><span>ready to call</span></div>
        <div><strong>{paused.length}</strong><span>paused</span></div>
      </div>
      <p className="month-only-hint" style={{ margin: '0 0 12px' }}>
        Live A/B tests from Intelligems, longest-running first. A test can be called when a variant has 300+ orders and RPV, AOV or CVR is at 95% (≥95% or ≤5% chance to beat control). Day estimates assume the current trend holds. 🟢 &lt;2 weeks · 🟡 2–4 weeks · 🟠 4+ weeks · 🔴 past estimated length. Read-only; refreshes every 5 minutes.
      </p>
      {live.length === 0 && <div className="empty-state">No live tests right now.</div>}
      <div className="tests-grid">{live.map(t => <Card key={t.id} t={t} />)}</div>
      {paused.length > 0 && (
        <>
          <div className="form-section-label" style={{ marginTop: 20 }}>⏸️ Paused</div>
          <div className="tests-grid">{paused.map(t => <Card key={t.id} t={t} />)}</div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function ListView({ items, onOpen, onToggleDone }: { items: Initiative[]; onOpen: (id: string) => void; onToggleDone: (i: Initiative) => void }) {
  const { listColor, pillarColor } = useColors();
  if (!items.length) return <div className="empty-state">No initiatives match your filters.</div>;
  const key = (i: Initiative) => spanOf(i)?.start || '9999';
  const sorted = [...items].sort((a, b) => Number(a.done) - Number(b.done) || key(a).localeCompare(key(b)));
  const anyPillar = items.some(i => i.pillar);
  return (
    <div className="scroll-x">
      <table className="list-table">
        <thead>
          <tr><th></th><th>Initiative</th><th>List</th>{anyPillar && <th>Pillar</th>}<th>Status</th><th>Priority</th><th>Owner</th><th>Calendar dates</th><th></th></tr>
        </thead>
        <tbody>
          {sorted.map(i => {
            const src = sourceOf(i);
            return (
              <tr key={i.id} className={i.done ? 'row-done' : ''}>
                <td style={{ width: 28 }}><input type="checkbox" className="card-check" checked={i.done} onChange={() => onToggleDone(i)} title="Mark done / not done" /></td>
                <td className="name"><button className="link-btn" onClick={() => onOpen(i.id)}>{i.name}</button>{i.bigSwing && <span className="chip-swing"> ★</span>}</td>
                <td style={{ whiteSpace: 'nowrap' }}><span className="list-dot" style={{ background: listColor(i.listId) }} />{i.listName}</td>
                {anyPillar && <td>{i.pillar && <span className="pillar-tag" style={{ color: pillarColor(i.pillar), borderColor: pillarColor(i.pillar) }}>{i.pillar}</span>}</td>}
                <td><span className="status-text"><StatusDot color={i.statusColor} /> {i.status}</span></td>
                <td style={{ color: PRIORITY_COLORS[i.priority] }}>{i.priority || '—'}</td>
                <td>{i.owners.map(o => o.name).join(', ') || '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }} title={SOURCE_LABEL[src]}>
                  {dateRangeLabel(i) || '—'}
                  {src === 'roadmap' && <span className="src-tag">roadmap</span>}
                  {src === 'sprint' && <span className="src-tag">sprint</span>}
                </td>
                <td>{i.url && <a href={i.url} target="_blank" rel="noreferrer" className="link-btn">ClickUp ↗</a>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editing — fields depend on which ClickUp list the task lives in
// ---------------------------------------------------------------------------

type FormValue = Partial<Initiative> & { ownerId?: number | null };

function ItemFields({ value, list, meta, monthAround, onChange }: {
  value: FormValue; list: ListMeta; meta: RoadmapMeta; monthAround: string;
  onChange: (patch: InitiativeInput) => void;
}) {
  const ownerId = value.ownerId !== undefined ? value.ownerId : value.owners?.[0]?.id ?? null;
  const hasNative = !!(value.startDate || value.dueDate);
  return (
    <>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Status</label>
          <select className="form-select" value={value.status || ''} onChange={e => onChange({ status: e.target.value })}>
            {!list.statuses.some(s => s.name === value.status) && <option value={value.status || ''}>{value.status || '—'}</option>}
            {list.statuses.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Priority</label>
          <select className="form-select" value={value.priority || ''} onChange={e => onChange({ priority: e.target.value })}>
            <option value="">None</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>

      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Owner</label>
          <select className="form-select" value={ownerId ?? ''} onChange={e => onChange({ ownerId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Unassigned</option>
            {meta.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            {value.owners?.filter(o => !meta.members.some(m => m.id === o.id)).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </div>
        {list.fields.pillar && (
          <div className="form-group">
            <label className="form-label">Pillar</label>
            <select className="form-select" value={value.pillar || ''} onChange={e => onChange({ pillar: e.target.value })}>
              <option value="">—</option>
              {list.pillars.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="form-section-label">Roadmap timing <span>— planned in whole weeks (Mon–Fri); writes Roadmap Start/End Date</span></div>
      {hasNative && (
        <div className="locked-dates">
          🔒 This task has its own ClickUp dates: <strong>{value.startDate ? shortDate(value.startDate) : '—'} → {value.dueDate ? shortDate(value.dueDate) : '—'}</strong>.
          They take priority on the roadmap and can only be changed in ClickUp.
        </div>
      )}
      {list.fields.roadmapStart && list.fields.roadmapEnd ? (
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">From week</label>
            <select className="form-select" value={value.roadmapStart ? mondayOf(value.roadmapStart) : ''} disabled={hasNative}
              onChange={e => {
                const mon = e.target.value;
                if (!mon) return onChange({ roadmapStart: '', roadmapEnd: '' });
                const keepEnd = value.roadmapEnd && value.roadmapEnd >= mon ? fridayOf(value.roadmapEnd) : fridayOf(mon);
                onChange({ roadmapStart: mon, roadmapEnd: keepEnd });
              }}>
              <option value="">Not scheduled</option>
              {weekChoices(monthAround, value.roadmapStart).map(m => <option key={m} value={m}>Week of {shortDate(m)}, {m.slice(0, 4)}{m < mondayOf(todayStr()) ? ' (past)' : ''}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Through week</label>
            <select className="form-select" value={value.roadmapEnd ? mondayOf(value.roadmapEnd) : ''} disabled={hasNative || !value.roadmapStart}
              onChange={e => {
                const mon = e.target.value;
                if (!mon) return;
                const start = value.roadmapStart && mondayOf(value.roadmapStart) <= mon ? mondayOf(value.roadmapStart) : mon;
                onChange({ roadmapStart: start, roadmapEnd: fridayOf(mon) });
              }}>
              {!value.roadmapStart && <option value="">—</option>}
              {weekChoices(monthAround, value.roadmapEnd).filter(m => !value.roadmapStart || m >= mondayOf(value.roadmapStart)).map(m => <option key={m} value={m}>Week of {shortDate(m)} (ends {shortDate(fridayOf(m))}){m < mondayOf(todayStr()) ? ' (past)' : ''}</option>)}
            </select>
          </div>
        </div>
      ) : <p className="field-hint">The “{list.name}” list is missing the Roadmap Start/End Date fields in ClickUp.</p>}
      {value.roadmapStart && <p className="field-hint">Roadmap: {shortDate(value.roadmapStart)} → {value.roadmapEnd ? shortDate(value.roadmapEnd) : '—'}{hasNative ? ' (not shown — task dates take priority)' : ''}</p>}

      {list.fields.testTargeting && (
        <div className="form-group">
          <label className="form-label">🧪 Test Targeting {isTestItem(value as Initiative) && !value.testTargeting && <span className="field-note">(needed to check for test conflicts)</span>}</label>
          <input className="form-input" key={(value as Initiative).id || 'new'} defaultValue={value.testTargeting || ''}
            placeholder="e.g. Homepage hero, PDP: kids-calming-magnesium, /collections/kids"
            onBlur={e => e.target.value.trim() !== (value.testTargeting || '') && onChange({ testTargeting: e.target.value.trim() })} />
          <p className="field-hint">Comma-separated pages/areas this test changes. Overlapping A/B tests on the same target (or URL paths inside each other, or “sitewide”) are flagged as conflicts.</p>
        </div>
      )}

      {list.fields.sprint && (
        <div className="form-group">
          <label className="form-label">Sprint</label>
          {list.sprintOptions.length
            ? (
              <select className="form-select" value={value.sprint || ''} onChange={e => onChange({ sprint: e.target.value })}>
                <option value="">—</option>
                {list.sprintOptions.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
              </select>
            )
            : <input className="form-input" defaultValue={value.sprint || ''} placeholder="e.g. 12: 2/23 - 2/27" onBlur={e => e.target.value !== (value.sprint || '') && onChange({ sprint: e.target.value })} />}
        </div>
      )}

      {list.fields.bigSwing && (
        <div className="form-group">
          <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!value.bigSwing} onChange={e => onChange({ bigSwing: e.target.checked })} style={{ width: 16, height: 16, accentColor: '#f59e0b' }} />
            Big Swing
          </label>
        </div>
      )}
    </>
  );
}

function DrawerConflicts({ id }: { id: string }) {
  const cs = useConflicts().get(id);
  if (!cs?.length) return null;
  return (
    <div className="conflict-banner" style={{ marginBottom: 14 }}>
      <strong>⚠️ Test conflict{cs.length > 1 ? 's' : ''}</strong>
      <ul>{cs.map(c => <li key={c.other.id}>{c.other.kind === 'intelligems' ? '🔴 Live test ' : ''}“{c.other.name}” ({c.other.where}) also targets <strong>{c.shared.join(', ')}</strong> {shortDate(c.from)} – {shortDate(c.to)}{c.other.kind === 'intelligems' && c.other.url ? <> · <a href={c.other.url} target="_blank" rel="noreferrer">open ↗</a></> : null}</li>)}</ul>
    </div>
  );
}

function Drawer({ item, meta, monthAround, onUpdate, onArchive, onClose }: {
  item: Initiative; meta: RoadmapMeta; monthAround: string;
  onUpdate: (id: string, patch: InitiativeInput) => void; onArchive: (id: string) => void; onClose: () => void;
}) {
  const { colorOf } = useColors();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const list = meta.lists.find(l => l.id === item.listId);

  return (
    <div className="drawer-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" key={item.id}>
        <div className="drawer-top">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close ✕</button>
          {item.url && <a className="btn btn-ghost btn-sm" href={item.url} target="_blank" rel="noreferrer">Open in ClickUp ↗</a>}
        </div>
        <div className="drawer-list"><span className="list-dot" style={{ background: colorOf(item) }} />{item.listName}</div>
        <textarea
          className="drawer-title"
          defaultValue={item.name}
          rows={2}
          onBlur={e => { const v = e.target.value.trim(); if (v && v !== item.name) onUpdate(item.id, { name: v }); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
        />
        <div className="drawer-sub">
          <StatusDot color={item.statusColor} /> {item.status}
          {dateRangeLabel(item) && <> · {dateRangeLabel(item)}</>}
        </div>
        <div className="drawer-source">On the roadmap via: <strong>{SOURCE_LABEL[sourceOf(item)]}</strong></div>
        <DrawerConflicts id={item.id} />

        {list
          ? <ItemFields value={item} list={list} meta={meta} monthAround={monthAround} onChange={patch => onUpdate(item.id, patch)} />
          : <p className="field-hint">This task’s list isn’t part of the roadmap configuration.</p>}

        <div className="form-group">
          <label className="form-label">Notes / description</label>
          <textarea className="form-textarea" rows={8} defaultValue={item.notes} placeholder="Hypothesis, expected impact, links…"
            onBlur={e => e.target.value !== item.notes && onUpdate(item.id, { notes: e.target.value })} />
          <p className="field-hint">Saved to the ClickUp task description.</p>
        </div>

        <div className="drawer-foot">
          <button className="btn btn-danger btn-sm" onClick={() => onArchive(item.id)}>Archive in ClickUp</button>
        </div>
      </aside>
    </div>
  );
}

function AddModal({ meta, defaults, monthAround, saving, onAdd, onClose }: {
  meta: RoadmapMeta; defaults: InitiativeInput; monthAround: string; saving: boolean;
  onAdd: (input: InitiativeInput & { name: string }) => void; onClose: () => void;
}) {
  const initialList = meta.lists.find(l => l.id === (defaults.listId || meta.defaultListId)) || meta.lists[0];
  const [form, setForm] = useState<InitiativeInput & { name: string; listId: string }>({
    name: '',
    priority: 'Normal',
    ...defaults,
    listId: initialList.id,
    status: initialList.statuses.find(s => !s.done)?.name || '',
  });
  const list = meta.lists.find(l => l.id === form.listId) || initialList;
  const set = (patch: InitiativeInput) => setForm(f => ({ ...f, ...patch }));
  const changeList = (id: string) => {
    const l = meta.lists.find(x => x.id === id)!;
    setForm(f => ({ ...f, listId: id, status: l.statuses.find(s => !s.done)?.name || '' }));
  };

  // Drop values the chosen list can't store, so ClickUp doesn't reject the create
  const submit = () => {
    const out: InitiativeInput & { name: string } = { ...form, name: form.name.trim() };
    if (!list.fields.roadmapStart) delete out.roadmapStart;
    if (!list.fields.roadmapEnd) delete out.roadmapEnd;
    if (!list.fields.pillar) delete out.pillar;
    if (!list.fields.sprint) delete out.sprint;
    onAdd(out);
  };

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 580 }}>
        <h2>Add to roadmap</h2>
        <div className="form-group">
          <label className="form-label">Initiative name *</label>
          <input className="form-input" value={form.name} onChange={e => set({ name: e.target.value })} placeholder="e.g. Checkout A/B test" autoFocus />
        </div>
        <div className="form-group">
          <label className="form-label">ClickUp list</label>
          <select className="form-select" value={form.listId} onChange={e => changeList(e.target.value)}>
            {meta.lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
        <ItemFields value={form as FormValue} list={list} meta={meta} monthAround={monthAround} onChange={set} />
        <div className="form-group">
          <label className="form-label">Notes / hypothesis</label>
          <textarea className="form-textarea" value={form.notes || ''} onChange={e => set({ notes: e.target.value })} placeholder="What's the expected impact?" />
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !form.name.trim()} onClick={submit}>{saving ? 'Saving…' : 'Create in ClickUp'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Cross-list stage of an item: not started (first/open status), in progress, or done. */
type Stage = 'todo' | 'doing' | 'done';
function stageOf(i: Initiative, lists: ListMeta[]): Stage {
  if (i.done) return 'done';
  const l = lists.find(x => x.id === i.listId);
  const st = l?.statuses.find(x => x.name === i.status);
  return !st || st.type === 'open' ? 'todo' : 'doing';
}
const STAGE_LABEL: Record<Stage, string> = { todo: '🕓 Not started', doing: '🔨 In progress', done: '✅ Done' };

export default function RoadmapPage() {
  const [items, setItems] = useState<Initiative[]>([]);
  const [meta, setMeta] = useState<RoadmapMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);

  const [from, setFrom] = useState(() => todayStr().slice(0, 7));
  const [span, setSpan] = useState(3);
  const [month, setMonth] = useState<string | null>(null);
  const [view, setViewState] = useState<'calendar' | 'list' | 'backlog' | 'tests'>('calendar');
  const setView = useCallback((v: 'calendar' | 'list' | 'backlog' | 'tests') => {
    setViewState(v);
    const q = new URLSearchParams(window.location.search);
    if (v === 'calendar') q.delete('view'); else q.set('view', v);
    const qs = q.toString();
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addDefaults, setAddDefaults] = useState<InitiativeInput | null>(null);

  const [search, setSearch] = useState('');
  const [fList, setFList] = useState('');
  const [fPillar, setFPillar] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fPriority, setFPriority] = useState('');
  const [fOwner, setFOwner] = useState('');
  const [fSwing, setFSwing] = useState('');
  const [fAttrs, setFAttrs] = useState<Record<string, string>>({});   // ROCK, TACTIC, … → option ('__none' = not set)
  const setAttr = (label: string, v: string) => setFAttrs(prev => { const n = { ...prev }; if (v) n[label] = v; else delete n[label]; return n; });

  // --- URL <-> navigation ---
  useEffect(() => {
    const sync = () => {
      const u = readUrl(); setFrom(u.from); setSpan(u.span); setMonth(u.month);
      const v = new URLSearchParams(window.location.search).get('view');
      setView(v === 'list' || v === 'backlog' || v === 'tests' ? v : 'calendar');
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const navigate = useCallback((next: { from: string; span: number; month: string | null }) => {
    setFrom(next.from);
    setSpan(next.span);
    setMonth(next.month);
    const nowYm = todayStr().slice(0, 7);
    const q = new URLSearchParams();
    if (next.month) q.set('month', next.month);
    else {
      if (next.from !== nowYm) q.set('from', next.from);
      if (next.span !== 3) q.set('span', String(next.span));
    }
    const qs = q.toString();
    window.history.pushState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);

  // --- Data ---
  const fetchAll = useCallback(async () => {
    try {
      const data = await api<{ items: Initiative[]; meta: RoadmapMeta }>('/api/initiatives');
      setItems(data.items);
      setMeta(data.meta);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { fetchAll(); }, [fetchAll]);

  const listOf = useCallback((listId: string) => meta?.lists.find(l => l.id === listId), [meta]);

  const applyLocal = useCallback((i: Initiative, patch: InitiativeInput): Initiative => {
    const next: Initiative = { ...i };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'ownerId') {
        const m = meta?.members.find(x => x.id === v) || i.owners.find(x => x.id === v);
        next.owners = m ? [m] : [];
      } else (next as any)[k] = v;
    }
    if (patch.status !== undefined) {
      const s = listOf(i.listId)?.statuses.find(x => x.name === patch.status);
      if (s) { next.statusColor = s.color; next.done = s.done; }
    }
    return next;
  }, [meta, listOf]);

  const updateItem = useCallback(async (id: string, patch: InitiativeInput) => {
    setItems(prev => prev.map(i => (i.id === id ? applyLocal(i, patch) : i)));
    setPending(n => n + 1);
    try {
      const updated = await api<Initiative>(`/api/initiatives/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
      setItems(prev => prev.map(i => (i.id === id ? updated : i)));
      setError('');
    } catch (err: any) {
      setError(`Couldn't save to ClickUp: ${err.message}`);
      fetchAll();
    } finally {
      setPending(n => n - 1);
    }
  }, [applyLocal, fetchAll]);

  const addItem = useCallback(async (input: InitiativeInput & { name: string }) => {
    setPending(n => n + 1);
    try {
      const created = await api<Initiative>('/api/initiatives', { method: 'POST', body: JSON.stringify(input) });
      setItems(prev => [...prev, created]);
      setAddDefaults(null);
      setError('');
    } catch (err: any) {
      setError(`Couldn't create in ClickUp: ${err.message}`);
    } finally {
      setPending(n => n - 1);
    }
  }, []);

  const archiveItem = useCallback(async (id: string) => {
    if (!confirm('Archive this task in ClickUp? It will disappear from the roadmap (you can restore it from ClickUp).')) return;
    setSelectedId(null);
    setItems(prev => prev.filter(i => i.id !== id));
    setPending(n => n + 1);
    try {
      await api(`/api/initiatives/${id}`, { method: 'DELETE' });
    } catch (err: any) {
      setError(`Couldn't archive: ${err.message}`);
      fetchAll();
    } finally {
      setPending(n => n - 1);
    }
  }, [fetchAll]);

  const toggleDone = useCallback((i: Initiative) => {
    const statuses = listOf(i.listId)?.statuses || [];
    const target = i.done ? statuses.find(s => !s.done) : statuses.find(s => s.done);
    if (target) updateItem(i.id, { status: target.name });
  }, [listOf, updateItem]);

  /**
   * Drop / plan an item onto a month or a week. Writes ONLY Roadmap Start/End Date
   * (Monday → Friday) — never the ClickUp task's own start/due dates.
   * Items that have their own start/due dates are locked (those dates take priority).
   */
  const scheduleTo = useCallback((id: string, t: Target) => {
    const it = items.find(i => i.id === id);
    if (!it) return;
    const list = listOf(it.listId);
    const sp = spanOf(it);
    if (sp?.source === 'dates') {
      setError(`“${it.name}” has its own start/due date in ClickUp, which takes priority. Change those dates in ClickUp — the roadmap won't modify them.`);
      return;
    }
    if (!list?.fields.roadmapStart || !list?.fields.roadmapEnd) {
      setError(`The “${it.listName}” list is missing the Roadmap Start/End Date fields in ClickUp.`);
      return;
    }
    // Length in weeks is preserved when moving something already on the roadmap
    const weeksLen = sp ? Math.round(diffDays(mondayOf(sp.start), mondayOf(sp.end)) / 7) : 0;
    let patch: InitiativeInput;
    if (t.kind === 'week') {
      const start = mondayOf(t.start);
      patch = { roadmapStart: start, roadmapEnd: addDays(fridayOf(start), 7 * weeksLen) };
    } else if (t.kind === 'day') {
      const start = mondayOf(t.date);
      patch = { roadmapStart: start, roadmapEnd: addDays(fridayOf(start), 7 * weeksLen) };
    } else {
      const whole = monthWeeks(t.ym);
      // Already scheduled: move to the first week of that month, same length.
      // Not scheduled yet: plan it across the month's weeks.
      patch = sp ? { roadmapStart: whole.roadmapStart, roadmapEnd: addDays(fridayOf(whole.roadmapStart), 7 * weeksLen) } : whole;
    }
    updateItem(id, patch);
  }, [items, listOf, updateItem]);

  // Live Intelligems tests (for the 🧪 tab and conflict checks); optional — app works without them
  const [tests, setTests] = useState<{ configured: boolean; tests: LiveTest[]; error?: string } | null>(null);
  useEffect(() => {
    fetch('/api/tests', { cache: 'no-store' })
      .then(r => r.json())
      .then(setTests)
      .catch(e => setTests({ configured: true, tests: [], error: String(e) }));
  }, []);
  const liveTests = tests?.tests || [];

  // Conflicts are computed across all items (not just the filtered view) plus live tests
  const conflicts = useMemo(() => findConflicts(items, liveTests), [items, liveTests]);

  // --- Colors ---
  const colors = useMemo<Colors>(() => {
    const byPillar = !!meta?.pillars.length;
    const listColor = (id: string) => meta?.lists.find(l => l.id === id)?.color || '#cbd5e1';
    const pillarColor = (p: string) => meta?.pillars.find(x => x.name === p)?.color || FALLBACK_PILLAR_COLORS[p] || '#cbd5e1';
    return {
      listColor,
      pillarColor,
      colorOf: i => (byPillar && i.pillar ? pillarColor(i.pillar) : listColor(i.listId)),
      groupOf: i => (byPillar ? i.pillar : i.listName),
    };
  }, [meta]);

  // --- Filtering ---
  const filtered = useMemo(() => items.filter(i => {
    if (fList && i.listId !== fList) return false;
    if (fPillar && i.pillar !== fPillar) return false;
    if (fStatus === '__open' && i.done) return false;
    if (fStatus.startsWith('__stage:') && stageOf(i, meta?.lists || []) !== fStatus.slice(8)) return false;
    if (fStatus.includes('::')) {
      const [lid, st] = fStatus.split('::');
      if (i.listId !== lid || i.status !== st) return false;
    }
    if (fPriority && i.priority !== fPriority) return false;
    if (fOwner && !i.owners.some(o => String(o.id) === fOwner)) return false;
    if (fSwing === 'yes' && !i.bigSwing) return false;
    if (fSwing === 'no' && i.bigSwing) return false;
    for (const [label, want] of Object.entries(fAttrs)) {
      const have = i.attrs?.[label] || [];
      if (want === '__none' ? have.length > 0 : !have.includes(want)) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      if (!i.name.toLowerCase().includes(q) && !i.notes.toLowerCase().includes(q) && !(i.testTargeting || '').toLowerCase().includes(q)) return false;
    }
    return true;
  }), [items, meta, fList, fPillar, fStatus, fPriority, fOwner, fSwing, fAttrs, search]);
  const activeFilters = [fList, fPillar, fStatus, fPriority, fOwner, fSwing, search].filter(Boolean).length + Object.keys(fAttrs).length;
  const clearFilters = () => { setSearch(''); setFList(''); setFPillar(''); setFStatus(''); setFPriority(''); setFOwner(''); setFSwing(''); setFAttrs({}); };

  const windowMonths = Array.from({ length: span }, (_, i) => shiftMonth(from, i));
  const scoped = month
    ? filtered.filter(i => inMonth(i, month))
    : filtered.filter(i => windowMonths.some(m => inMonth(i, m)));
  const done = scoped.filter(i => i.done).length;
  const pct = scoped.length ? Math.round((done / scoped.length) * 100) : 0;
  const selected = items.find(i => i.id === selectedId) || null;
  const monthAround = month || todayStr().slice(0, 7);
  const anyBigSwing = meta?.lists.some(l => l.fields.bigSwing);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <span style={{ fontSize: 13, color: '#6b7280' }}>Loading roadmap from ClickUp…</span>
      </div>
    );
  }

  const nowYm = todayStr().slice(0, 7);
  const goPrev = () => navigate(month ? { from, span, month: shiftMonth(month, -1) } : { from: shiftMonth(from, -1), span, month: null });
  const goNext = () => navigate(month ? { from, span, month: shiftMonth(month, 1) } : { from: shiftMonth(from, 1), span, month: null });
  const goToday = () => navigate(month ? { from, span, month: nowYm } : { from: nowYm, span, month: null });
  const windowLabel = `${monthLabel(windowMonths[0], true)} – ${monthLabel(windowMonths[windowMonths.length - 1], true)}`;

  return (
    <ColorCtx.Provider value={colors}>
    <ConflictCtx.Provider value={conflicts}>
    <ScheduleCtx.Provider value={scheduleTo}>
      <div className="app">
        {pending > 0 && <div className="saving-indicator">Saving to ClickUp…</div>}

        <div className="header">
          <div className="header-left">
            <h1>firstday.com — Roadmap</h1>
            <p>
              Synced with ClickUp · {meta?.lists.length || 0} lists
              {meta?.mock && <span className="mock-badge">MOCK DATA</span>}
            </p>
          </div>
          <div className="header-right">
            <Link href="/requests" className="btn btn-ghost btn-sm">Requests</Link>
            <Link href="/request" className="btn btn-ghost btn-sm">Submit request</Link>
            <Link href="/accomplishments" className="btn btn-ghost btn-sm">Accomplishments</Link>
            <Link href="/config" className="btn btn-ghost btn-sm" title="Configuration">⚙</Link>
            <button className="btn btn-ghost btn-sm" onClick={() => exportCSV(scoped)}>↓ CSV</button>
            {meta && <button className="btn btn-primary btn-sm" onClick={() => setAddDefaults(month ? monthWeeks(month) : {})}>+ Add</button>}
            <AuthStatus />
          </div>
        </div>

        {error && (
          <div className="error-banner">
            <span>⚠</span> {error}
            <button onClick={() => { setError(''); fetchAll(); }} className="error-retry">Retry</button>
          </div>
        )}

        <div className="month-window">
          <div className="month-window-left">
            <nav className="crumbs">
              <button className={`crumb ${!month ? 'crumb-active' : ''}`} onClick={() => navigate({ from, span, month: null })} title="Back to the overview">{month ? '‹ Overview' : windowLabel}</button>
              {month && <><span className="crumb-sep">›</span><span className="crumb crumb-active">{monthLabel(month)}</span></>}
            </nav>
            <button className="month-nav-btn" title="Previous month" onClick={goPrev}>‹</button>
            <button className="month-nav-btn" title="Next month" onClick={goNext}>›</button>
            <button className="btn btn-ghost btn-sm" onClick={goToday} disabled={month ? month === nowYm : from === nowYm}>Today</button>
            {!month && view === 'calendar' && (
              <div className="view-toggle" style={{ marginLeft: 4 }}>
                {SPANS.map(n => <button key={n} className={span === n ? 'active' : ''} onClick={() => navigate({ from, span: n, month: null })} title={`Show ${n} months`}>{n}M</button>)}
              </div>
            )}
            <span className="month-window-range">{scoped.length} items · {pct}% done</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className={`btn btn-ghost btn-sm ${activeFilters ? 'btn-on' : ''}`} onClick={() => setShowFilters(s => !s)}>
              Filters{activeFilters ? ` (${activeFilters})` : ''}
            </button>
            <div className="view-toggle" style={{ marginLeft: 0 }}>
              <button className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>Calendar</button>
              <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
              <button className={view === 'backlog' ? 'active' : ''} onClick={() => setView('backlog')} title="Every item in every list — plan into months">Backlog</button>
              <button className={view === 'tests' ? 'active' : ''} onClick={() => setView('tests')} title="Live Intelligems A/B tests and how long they've run">🧪 Tests</button>
            </div>
          </div>
        </div>

        {(showFilters || view === 'backlog') && view !== 'tests' && meta && (
          <div className="filters">
            <input className={`filter-input ${search ? 'filter-on' : ''}`} placeholder="🔎 Search tickets…" value={search} onChange={e => setSearch(e.target.value)} />
            <select className={`filter-select ${fList ? 'filter-on' : ''}`} value={fList} onChange={e => setFList(e.target.value)}>
              <option value="">📋 All lists</option>
              {meta.lists.map(l => <option key={l.id} value={l.id}>📋 {l.name}</option>)}
            </select>
            {meta.pillars.length > 0 && (
              <select className={`filter-select ${fPillar ? 'filter-on' : ''}`} value={fPillar} onChange={e => setFPillar(e.target.value)}>
                <option value="">🏛️ All pillars</option>
                {meta.pillars.map(p => <option key={p.id} value={p.name}>🏛️ {p.name}</option>)}
              </select>
            )}
            <select className={`filter-select ${fStatus ? 'filter-on' : ''}`} value={fStatus} onChange={e => setFStatus(e.target.value)}>
              <option value="">📍 All statuses</option>
              <optgroup label="Stage (all lists)">
                <option value="__open">⏳ Not done</option>
                {(['todo', 'doing', 'done'] as Stage[]).map(st => (
                  <option key={st} value={`__stage:${st}`}>{STAGE_LABEL[st]} ({items.filter(i => stageOf(i, meta.lists) === st).length})</option>
                ))}
              </optgroup>
              {meta.lists.filter(l => !fList || l.id === fList).map(l => {
                const opts = l.statuses
                  .map(st => ({ st, n: items.filter(i => i.listId === l.id && i.status === st.name).length }))
                  .filter(x => x.n > 0 || fStatus === `${l.id}::${x.st.name}`);
                if (!opts.length) return null;
                return (
                  <optgroup key={l.id} label={`📋 ${l.name}`}>
                    {opts.map(({ st, n }) => (
                      <option key={st.name} value={`${l.id}::${st.name}`}>{st.done ? '✅' : st.type === 'open' ? '🕓' : '🔨'} {st.name} ({n})</option>
                    ))}
                  </optgroup>
                );
              })}
            </select>
            <select className={`filter-select ${fPriority ? 'filter-on' : ''}`} value={fPriority} onChange={e => setFPriority(e.target.value)}>
              <option value="">⚡ All priorities</option>
              {PRIORITIES.map(p => <option key={p} value={p}>⚡ {p}</option>)}
            </select>
            <select className={`filter-select ${fOwner ? 'filter-on' : ''}`} value={fOwner} onChange={e => setFOwner(e.target.value)}>
              <option value="">👤 All assignees</option>
              {meta.members.map(m => <option key={m.id} value={m.id}>👤 {m.name}</option>)}
            </select>
            {anyBigSwing && (
              <select className={`filter-select ${fSwing ? 'filter-on' : ''}`} value={fSwing} onChange={e => setFSwing(e.target.value)}>
                <option value="">⭐ All initiatives</option>
                <option value="yes">⭐ Big Swings only</option>
                <option value="no">⭐ Non-Big Swings</option>
              </select>
            )}
            {meta.filterFields.filter(ff => !fList || ff.lists.includes(fList) || fAttrs[ff.label]).map(ff => (
              <select key={ff.label} className={`filter-select ${fAttrs[ff.label] ? 'filter-on' : ''}`} value={fAttrs[ff.label] || ''} onChange={e => setAttr(ff.label, e.target.value)}
                title={`Filter by the ClickUp field “${ff.label}” (on ${ff.lists.map(id => meta.lists.find(l => l.id === id)?.name).filter(Boolean).join(', ')})`}>
                <option value="">{fieldEmoji(ff.label)} {ff.label}: any</option>
                <option value="__none">{fieldEmoji(ff.label)} {ff.label}: not set</option>
                {ff.options.map(o => <option key={o.id} value={o.name}>{fieldEmoji(ff.label)} {o.name}</option>)}
              </select>
            ))}
            {activeFilters > 0 && <button className="btn btn-ghost btn-sm" onClick={clearFilters}>Clear ({activeFilters})</button>}
          </div>
        )}

        {meta && view === 'calendar' && <Legend meta={meta} />}

        {view === 'tests'
          ? <TestsView data={tests} />
          : view === 'backlog' && meta
          ? <BacklogView items={filtered} meta={meta} onOpen={setSelectedId} onSchedule={scheduleTo} />
          : view === 'list'
          ? <ListView items={scoped} onOpen={setSelectedId} onToggleDone={toggleDone} />
          : month
            ? <MonthView monthKey={month} items={filtered} lists={meta?.lists || []} liveTests={liveTests} onUpdate={updateItem} onOpen={setSelectedId} onAdd={d => setAddDefaults(d)} />
            : <OverviewView months={windowMonths} items={filtered} onOpenMonth={m => navigate({ from, span, month: m })} onOpenItem={setSelectedId} />}

        {selected && meta && <Drawer item={selected} meta={meta} monthAround={monthAround} onUpdate={updateItem} onArchive={archiveItem} onClose={() => setSelectedId(null)} />}
        {addDefaults && meta && <AddModal meta={meta} defaults={addDefaults} monthAround={monthAround} saving={pending > 0} onAdd={addItem} onClose={() => setAddDefaults(null)} />}
      </div>
    </ScheduleCtx.Provider>
    </ConflictCtx.Provider>
    </ColorCtx.Provider>
  );
}

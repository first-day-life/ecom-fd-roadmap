'use client';

import { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from 'react';
import Link from 'next/link';
import type { Initiative, InitiativeInput, RoadmapMeta, ListMeta } from '@/lib/types';
import { PRIORITIES } from '@/lib/types';
import {
  MONTH_NAMES, DAY_SHORT, addDays, diffDays, monthStart, monthEnd, monthLabel, shiftMonth, shortDate,
  weeksOfMonth, overlaps, todayStr, ym, parseSprintRange, toUTC,
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
 * Items with none of these fall back to their Target Month (month level only).
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
    const year = Number(i.roadmapMonth.slice(0, 4)) || new Date().getFullYear();
    const r = parseSprintRange(i.sprint, year);
    if (r) return { ...r, source: 'sprint' };
  }
  return null;
}

const SOURCE_LABEL: Record<Span['source'] | 'month' | 'none', string> = {
  dates: 'Task start/due dates',
  roadmap: 'Roadmap Start/End Date fields (task has no start/due date)',
  sprint: 'Dates parsed from the sprint name',
  month: 'Target Month only — no dates yet',
  none: 'Not on the calendar — no dates or month set',
};

function sourceOf(i: Initiative): keyof typeof SOURCE_LABEL {
  return spanOf(i)?.source || (i.roadmapMonth ? 'month' : 'none');
}

function inMonth(i: Initiative, ymStr: string): boolean {
  const sp = spanOf(i);
  if (sp) return overlaps(sp.start, sp.end, monthStart(ymStr), monthEnd(ymStr));
  return i.roadmapMonth === ymStr;
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
// Misc helpers
// ---------------------------------------------------------------------------

function readUrl(): { year: number; month: string | null } {
  if (typeof window === 'undefined') return { year: new Date().getFullYear(), month: null };
  const q = new URLSearchParams(window.location.search);
  const month = q.get('month');
  if (month && /^\d{4}-\d{2}$/.test(month)) return { year: Number(month.slice(0, 4)), month };
  return { year: Number(q.get('year')) || new Date().getFullYear(), month: null };
}

function exportCSV(items: Initiative[]) {
  const headers = ['Name', 'List', 'Pillar', 'Status', 'Priority', 'Owner', 'Start', 'Due', 'Roadmap Start', 'Roadmap End', 'Target Month', 'Sprint', 'Big Swing', 'ClickUp URL', 'Notes'];
  const rows = items.map(i => [i.name, i.listName, i.pillar, i.status, i.priority, i.owners.map(o => o.name).join('; '), i.startDate, i.dueDate, i.roadmapStart, i.roadmapEnd, i.roadmapMonth ? monthLabel(i.roadmapMonth) : '', i.sprint, i.bigSwing ? 'Yes' : 'No', i.url, i.notes]
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

/** Month choices: the dropdown's own options when it has them, else a rolling range. */
function monthChoices(list: ListMeta | undefined, around: string): string[] {
  if (list?.monthOptions.length) return list.monthOptions;
  const out: string[] = [];
  for (let d = -6; d <= 12; d++) out.push(shiftMonth(around, d));
  return out;
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
  return (
    <button
      className={`chip ${item.done ? 'chip-done' : ''}`}
      style={{ borderLeftColor: colorOf(item) }}
      onClick={() => onOpen(item.id)}
      draggable={draggable}
      onDragStart={draggable ? e => { e.dataTransfer.setData('text/roadmap-id', item.id); e.dataTransfer.effectAllowed = 'move'; } : undefined}
      title={`${item.name}\n${item.listName} · ${item.status}\n${SOURCE_LABEL[sourceOf(item)]}`}
    >
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
      <span className="legend-item"><span className="legend-bar" /> Task dates</span>
      <span className="legend-item"><span className="legend-bar legend-bar-soft" /> Roadmap dates (no task dates)</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Year view — 12 month cards
// ---------------------------------------------------------------------------

function YearView({ year, items, onOpenMonth, onOpenItem }: {
  year: number; items: Initiative[]; onOpenMonth: (ym: string) => void; onOpenItem: (id: string) => void;
}) {
  const { colorOf, groupOf } = useColors();
  const nowYm = todayStr().slice(0, 7);
  const unplanned = items.filter(i => sourceOf(i) === 'none');
  const [showUnplanned, setShowUnplanned] = useState(false);

  return (
    <>
      <div className="year-grid">
        {MONTH_NAMES.map((name, idx) => {
          const key = ym(year, idx);
          const monthItems = items.filter(i => inMonth(i, key));
          const done = monthItems.filter(i => i.done).length;
          const pct = monthItems.length ? Math.round((done / monthItems.length) * 100) : 0;
          const groups = new Map<string, { n: number; color: string }>();
          monthItems.forEach(i => {
            const g = groupOf(i) || '—';
            groups.set(g, { n: (groups.get(g)?.n || 0) + 1, color: colorOf(i) });
          });
          const sorted = [...monthItems].sort((a, b) => Number(a.done) - Number(b.done) || Number(b.bigSwing) - Number(a.bigSwing));
          return (
            <div key={key} className={`month-card ${key === nowYm ? 'month-card-current' : ''} ${key < nowYm ? 'month-card-past' : ''}`}>
              <button className="month-card-head" onClick={() => onOpenMonth(key)}>
                <span className="month-card-name">{name}</span>
                <span className="month-card-count">{monthItems.length}</span>
                <span className="month-card-open">Open →</span>
              </button>
              <div className="month-card-pillars">
                {Array.from(groups.entries()).map(([g, v]) => (
                  <span key={g} className="pillar-tag" style={{ color: v.color, borderColor: v.color }} title={g}>
                    {g.length > 14 ? g.slice(0, 13) + '…' : g} {v.n}
                  </span>
                ))}
                {monthItems.length > 0 && <span className="month-card-pct">{pct}% done</span>}
              </div>
              <div className="progress-bar-bg" style={{ margin: '6px 0 8px' }}><div className="progress-bar-fill" style={{ width: pct + '%' }} /></div>
              <div className="month-card-items">
                {sorted.slice(0, 6).map(i => (
                  <button key={i.id} className={`month-card-item ${i.done ? 'is-done' : ''}`} onClick={() => onOpenItem(i.id)} title={`${i.name} · ${i.listName}`}>
                    <span className="pillar-bar" style={{ background: colorOf(i) }} />
                    <span className="month-card-item-name">{i.name}</span>
                    {i.bigSwing && <span className="chip-swing">★</span>}
                  </button>
                ))}
                {sorted.length > 6 && <button className="month-card-more" onClick={() => onOpenMonth(key)}>+{sorted.length - 6} more</button>}
                {sorted.length === 0 && <div className="month-card-empty">Nothing planned</div>}
              </div>
            </div>
          );
        })}
      </div>

      {unplanned.length > 0 && (
        <div className="unplanned">
          <button className="unplanned-head" onClick={() => setShowUnplanned(s => !s)}>
            {showUnplanned ? '▾' : '▸'} Unplanned <span className="count-badge">{unplanned.length}</span>
            <span className="unplanned-hint">No start/due date, roadmap dates, sprint or Target Month</span>
          </button>
          {showUnplanned && <div className="chip-wrap">{unplanned.map(i => <ItemChip key={i.id} item={i} onOpen={onOpenItem} />)}</div>}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Week grid — day columns with draggable / resizable bars
// ---------------------------------------------------------------------------

type DragState = { id: string; mode: 'start' | 'end' | 'move'; source: Span['source']; startX: number; s0: string; e0: string; s: string; e: string; moved: boolean };

function WeekGrid({ days, monthKey, items, onUpdate, onOpen, canRoadmapDate }: {
  days: string[]; monthKey: string; items: Initiative[];
  onUpdate: (id: string, patch: InitiativeInput) => void; onOpen: (id: string) => void;
  canRoadmapDate: (id: string) => boolean;
}) {
  const { colorOf } = useColors();
  const gridRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const today = todayStr();
  const weekStart = days[0];

  const begin = (e: React.PointerEvent, item: Initiative, mode: DragState['mode']) => {
    const sp = spanOf(item);
    if (!sp || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const st: DragState = { id: item.id, mode, source: sp.source, startX: e.clientX, s0: sp.start, e0: sp.end, s: sp.start, e: sp.end, moved: false };
    dragRef.current = st;
    setDrag(st);

    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur || !gridRef.current) return;
      const colW = gridRef.current.getBoundingClientRect().width / 7;
      const delta = Math.round((ev.clientX - cur.startX) / colW);
      let s = cur.s0, en = cur.e0;
      if (cur.mode === 'move') { s = addDays(cur.s0, delta); en = addDays(cur.e0, delta); }
      if (cur.mode === 'start') { s = addDays(cur.s0, delta); if (s > cur.e0) s = cur.e0; }
      if (cur.mode === 'end') { en = addDays(cur.e0, delta); if (en < cur.s0) en = cur.s0; }
      const next = { ...cur, s, e: en, moved: cur.moved || Math.abs(ev.clientX - cur.startX) > 3 };
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
      if (cur.s === cur.s0 && cur.e === cur.e0) return;
      // Write back to whichever source placed the item on the calendar
      if (cur.source === 'roadmap') onUpdate(cur.id, { roadmapStart: cur.s, roadmapEnd: cur.e });
      else onUpdate(cur.id, { startDate: cur.s, dueDate: cur.e });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const rows = items
    .map(i => {
      const sp = spanOf(i)!;
      const s = drag?.id === i.id ? drag.s : sp.start;
      const e = drag?.id === i.id ? drag.e : sp.end;
      return { item: i, s, e, source: sp.source };
    })
    .sort((a, b) => a.s.localeCompare(b.s) || a.e.localeCompare(b.e));

  return (
    <div className="week-grid-wrap">
      <div className="week-grid-head">
        {days.map((d, idx) => (
          <div
            key={d}
            className={`day-head ${d.slice(0, 7) !== monthKey ? 'day-out' : ''} ${d === today ? 'day-today' : ''} ${idx >= 5 ? 'day-weekend' : ''} ${dropDay === d ? 'day-drop' : ''}`}
            onDragOver={e => { if (e.dataTransfer.types.includes('text/roadmap-id')) { e.preventDefault(); setDropDay(d); } }}
            onDragLeave={() => setDropDay(x => (x === d ? null : x))}
            onDrop={e => {
              const id = e.dataTransfer.getData('text/roadmap-id');
              setDropDay(null);
              if (!id) return;
              if (canRoadmapDate(id)) onUpdate(id, { roadmapStart: d, roadmapEnd: d });
              else onUpdate(id, { startDate: d, dueDate: d });
            }}
          >
            <span>{DAY_SHORT[idx]}</span>
            <strong>{toUTC(d).getUTCDate()}</strong>
          </div>
        ))}
      </div>
      <div className="week-grid" ref={gridRef}>
        {days.map((d, idx) => (
          <div key={d} className={`day-col ${idx >= 5 ? 'day-weekend' : ''} ${d === today ? 'day-today' : ''}`} style={{ gridColumn: idx + 1, gridRow: `1 / span ${Math.max(rows.length, 1)}` }} />
        ))}
        {rows.length === 0 && <div className="week-empty" style={{ gridColumn: '1 / 8', gridRow: 1 }}>Nothing dated this week — drag a chip from “Planned for this month” onto a day above.</div>}
        {rows.map(({ item, s, e, source }, r) => {
          const a = Math.max(0, diffDays(weekStart, s));
          const b = Math.min(6, diffDays(weekStart, e));
          if (b < 0 || a > 6) return null;
          const clipL = s < weekStart;
          const clipR = e > days[6];
          const active = drag?.id === item.id;
          const resizable = true;
          return (
            <div
              key={item.id}
              className={`bar ${item.done ? 'bar-done' : ''} ${active ? 'bar-active' : ''} ${source !== 'dates' ? 'bar-soft' : ''} ${clipL ? 'clip-l' : ''} ${clipR ? 'clip-r' : ''}`}
              style={{ gridColumn: `${a + 1} / ${b + 2}`, gridRow: r + 1, '--bar': colorOf(item) } as React.CSSProperties}
              onPointerDown={e => begin(e, item, 'move')}
              title={`${item.name} · ${item.listName}\n${shortDate(s)}${s !== e ? ` – ${shortDate(e)}` : ''} — ${SOURCE_LABEL[source]}\nDrag to move · drag edges to change dates · click for details`}
            >
              {!clipL && resizable && <span className="bar-handle bar-handle-l" onPointerDown={e => begin(e, item, 'start')} />}
              {clipL && <span className="bar-arrow">‹</span>}
              <StatusDot color={item.statusColor} />
              <span className="bar-name">{item.name}</span>
              {item.bigSwing && <span className="chip-swing">★</span>}
              {active && <span className="bar-dates">{shortDate(s)}{s !== e ? ` – ${shortDate(e)}` : ''}</span>}
              <Avatars owners={item.owners} />
              {clipR && <span className="bar-arrow">›</span>}
              {!clipR && resizable && <span className="bar-handle bar-handle-r" onPointerDown={e => begin(e, item, 'end')} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month view — weeks that expand into days
// ---------------------------------------------------------------------------

function MonthView({ monthKey, items, onUpdate, onOpen, onAdd, canRoadmapDate }: {
  monthKey: string; items: Initiative[];
  onUpdate: (id: string, patch: InitiativeInput) => void; onOpen: (id: string) => void;
  onAdd: (defaults: InitiativeInput) => void; canRoadmapDate: (id: string) => boolean;
}) {
  const weeks = useMemo(() => weeksOfMonth(monthKey), [monthKey]);
  const today = todayStr();
  const currentWeek = (ws: string[][]) => ws.find(w => w[0] <= today && today <= w[6]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(currentWeek(weeks) ? [currentWeek(weeks)![0]] : []));
  useEffect(() => {
    const cur = currentWeek(weeks);
    setExpanded(new Set(cur ? [cur[0]] : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey]);

  const monthItems = items.filter(i => inMonth(i, monthKey));
  const monthOnly = monthItems.filter(i => !spanOf(i));
  const toggle = (k: string) => setExpanded(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  return (
    <div className="month-view">
      <div className="month-view-tools">
        <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(new Set(weeks.map(w => w[0])))}>Expand all weeks</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setExpanded(new Set())}>Collapse all</button>
        <span className="month-view-hint">Click a week to open its days · drag a bar to move it · drag its edges to change dates</span>
      </div>

      {weeks.map((days, wi) => {
        const key = days[0];
        const weekItems = monthItems.filter(i => { const sp = spanOf(i); return sp && overlaps(sp.start, sp.end, days[0], days[6]); });
        const isOpen = expanded.has(key);
        const isCurrent = days[0] <= today && today <= days[6];
        const firstInMonth = days.find(d => d.slice(0, 7) === monthKey)!;
        return (
          <section key={key} className={`week ${isOpen ? 'week-open' : ''} ${isCurrent ? 'week-current' : ''}`}>
            <div className="week-head">
              <button className="week-toggle" onClick={() => toggle(key)}>
                <span className="week-caret">{isOpen ? '▾' : '▸'}</span>
                <span className="week-title">Week {wi + 1}</span>
                <span className="week-range">{shortDate(days[0])} – {shortDate(days[6])}</span>
                <span className="count-badge">{weekItems.length}</span>
                {isCurrent && <span className="week-now">This week</span>}
              </button>
              <button className="btn btn-ghost btn-sm week-add" onClick={() => onAdd({ roadmapStart: firstInMonth, roadmapEnd: days.filter(d => d.slice(0, 7) === monthKey).slice(-1)[0], roadmapMonth: monthKey })}>+ Add</button>
            </div>
            {isOpen
              ? <WeekGrid days={days} monthKey={monthKey} items={weekItems} onUpdate={onUpdate} onOpen={onOpen} canRoadmapDate={canRoadmapDate} />
              : weekItems.length > 0 && <div className="chip-wrap week-chips">{weekItems.map(i => <ItemChip key={i.id} item={i} onOpen={onOpen} />)}</div>}
          </section>
        );
      })}

      <section className="week month-only">
        <div className="week-head">
          <div className="week-toggle" style={{ cursor: 'default' }}>
            <span className="week-title">Planned for {MONTH_NAMES[Number(monthKey.slice(5)) - 1]} — no dates yet</span>
            <span className="count-badge">{monthOnly.length}</span>
          </div>
          <button className="btn btn-ghost btn-sm week-add" onClick={() => onAdd({ roadmapMonth: monthKey })}>+ Add</button>
        </div>
        {monthOnly.length > 0
          ? (
            <>
              <div className="chip-wrap week-chips">{monthOnly.map(i => <ItemChip key={i.id} item={i} onOpen={onOpen} draggable />)}</div>
              <p className="month-only-hint">These only have a Target Month. Drag one onto a day in an expanded week to set its Roadmap Start/End Date, then drag the bar’s edges to stretch it.</p>
            </>
          )
          : <p className="month-only-hint">Everything this month has dates.</p>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function ListView({ items, onOpen, onToggleDone }: { items: Initiative[]; onOpen: (id: string) => void; onToggleDone: (i: Initiative) => void }) {
  const { listColor, pillarColor } = useColors();
  if (!items.length) return <div className="empty-state">No initiatives match your filters.</div>;
  const key = (i: Initiative) => spanOf(i)?.start || (i.roadmapMonth ? i.roadmapMonth + '-99' : '9999');
  const sorted = [...items].sort((a, b) => Number(a.done) - Number(b.done) || key(a).localeCompare(key(b)));
  const anyPillar = items.some(i => i.pillar);
  return (
    <div className="scroll-x">
      <table className="list-table">
        <thead>
          <tr><th></th><th>Initiative</th><th>List</th>{anyPillar && <th>Pillar</th>}<th>Status</th><th>Priority</th><th>Owner</th><th>Calendar dates</th><th>Month</th><th></th></tr>
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
                <td style={{ whiteSpace: 'nowrap' }}>{i.roadmapMonth ? monthLabel(i.roadmapMonth, true) : '—'}</td>
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

      <div className="form-section-label">Dates <span>— the task’s own start/due dates win; roadmap dates are used only when those are empty</span></div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Start date</label>
          <input type="date" className="form-input" value={value.startDate || ''} onChange={e => onChange({ startDate: e.target.value })} />
        </div>
        <div className="form-group">
          <label className="form-label">Due date</label>
          <input type="date" className="form-input" value={value.dueDate || ''} onChange={e => onChange({ dueDate: e.target.value })} />
        </div>
      </div>
      {(list.fields.roadmapStart || list.fields.roadmapEnd) && (
        <div className="form-row">
          {list.fields.roadmapStart && (
            <div className="form-group">
              <label className="form-label">Roadmap Start Date</label>
              <input type="date" className="form-input" value={value.roadmapStart || ''} onChange={e => onChange({ roadmapStart: e.target.value })} />
            </div>
          )}
          {list.fields.roadmapEnd && (
            <div className="form-group">
              <label className="form-label">Roadmap End Date</label>
              <input type="date" className="form-input" value={value.roadmapEnd || ''} onChange={e => onChange({ roadmapEnd: e.target.value })} />
            </div>
          )}
        </div>
      )}
      {hasNative && (value.roadmapStart || value.roadmapEnd) && <p className="field-hint">Roadmap dates are set but not shown — this task’s own start/due dates take priority.</p>}
      <div className="form-row">
        {list.fields.roadmapMonth && (
          <div className="form-group">
            <label className="form-label">Target Month</label>
            <select className="form-select" value={value.roadmapMonth || ''} onChange={e => onChange({ roadmapMonth: e.target.value })}>
              <option value="">—</option>
              {value.roadmapMonth && !monthChoices(list, monthAround).includes(value.roadmapMonth) && <option value={value.roadmapMonth}>{monthLabel(value.roadmapMonth)}</option>}
              {monthChoices(list, monthAround).map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          </div>
        )}
      </div>
      {!(list.fields.roadmapStart && list.fields.roadmapEnd) && <p className="field-hint">The “{list.name}” list is missing the Roadmap Start/End Date fields in ClickUp.</p>}

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
    if (!list.fields.roadmapMonth || (list.monthOptions.length && out.roadmapMonth && !list.monthOptions.includes(out.roadmapMonth))) delete out.roadmapMonth;
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

export default function RoadmapPage() {
  const [items, setItems] = useState<Initiative[]>([]);
  const [meta, setMeta] = useState<RoadmapMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);

  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState<string | null>(null);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
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

  // --- URL <-> navigation ---
  useEffect(() => {
    const sync = () => { const u = readUrl(); setYear(u.year); setMonth(u.month); };
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const navigate = useCallback((next: { year: number; month: string | null }) => {
    setYear(next.year);
    setMonth(next.month);
    const q = next.month ? `?month=${next.month}` : next.year !== new Date().getFullYear() ? `?year=${next.year}` : '';
    window.history.pushState(null, '', window.location.pathname + q);
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

  const canRoadmapDate = useCallback((id: string) => {
    const it = items.find(i => i.id === id);
    return !!(it && listOf(it.listId)?.fields.roadmapStart && listOf(it.listId)?.fields.roadmapEnd);
  }, [items, listOf]);

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
  const allStatuses = useMemo(() => Array.from(new Set((meta?.lists || []).flatMap(l => l.statuses.map(s => s.name)))), [meta]);
  const filtered = useMemo(() => items.filter(i => {
    if (fList && i.listId !== fList) return false;
    if (fPillar && i.pillar !== fPillar) return false;
    if (fStatus === '__open' && i.done) return false;
    if (fStatus === '__done' && !i.done) return false;
    if (fStatus && !fStatus.startsWith('__') && i.status !== fStatus) return false;
    if (fPriority && i.priority !== fPriority) return false;
    if (fOwner && !i.owners.some(o => String(o.id) === fOwner)) return false;
    if (fSwing === 'yes' && !i.bigSwing) return false;
    if (fSwing === 'no' && i.bigSwing) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!i.name.toLowerCase().includes(q) && !i.notes.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [items, fList, fPillar, fStatus, fPriority, fOwner, fSwing, search]);
  const activeFilters = [fList, fPillar, fStatus, fPriority, fOwner, fSwing, search].filter(Boolean).length;
  const clearFilters = () => { setSearch(''); setFList(''); setFPillar(''); setFStatus(''); setFPriority(''); setFOwner(''); setFSwing(''); };

  const scoped = month
    ? filtered.filter(i => inMonth(i, month))
    : filtered.filter(i => MONTH_NAMES.some((_, m) => inMonth(i, ym(year, m))));
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

  const goPrev = () => month ? navigate({ year: Number(shiftMonth(month, -1).slice(0, 4)), month: shiftMonth(month, -1) }) : navigate({ year: year - 1, month: null });
  const goNext = () => month ? navigate({ year: Number(shiftMonth(month, 1).slice(0, 4)), month: shiftMonth(month, 1) }) : navigate({ year: year + 1, month: null });
  const goToday = () => navigate({ year: new Date().getFullYear(), month: month ? todayStr().slice(0, 7) : null });

  return (
    <ColorCtx.Provider value={colors}>
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
            {meta && <button className="btn btn-primary btn-sm" onClick={() => setAddDefaults(month ? { roadmapMonth: month } : {})}>+ Add</button>}
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
              <button className={`crumb ${!month ? 'crumb-active' : ''}`} onClick={() => navigate({ year, month: null })}>{year}</button>
              {month && <><span className="crumb-sep">›</span><span className="crumb crumb-active">{MONTH_NAMES[Number(month.slice(5)) - 1]}</span></>}
            </nav>
            <button className="month-nav-btn" title={month ? 'Previous month' : 'Previous year'} onClick={goPrev}>‹</button>
            <button className="month-nav-btn" title={month ? 'Next month' : 'Next year'} onClick={goNext}>›</button>
            <button className="btn btn-ghost btn-sm" onClick={goToday}>Today</button>
            <span className="month-window-range">{scoped.length} items · {pct}% done</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className={`btn btn-ghost btn-sm ${activeFilters ? 'btn-on' : ''}`} onClick={() => setShowFilters(s => !s)}>
              Filters{activeFilters ? ` (${activeFilters})` : ''}
            </button>
            <div className="view-toggle" style={{ marginLeft: 0 }}>
              <button className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>Calendar</button>
              <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
            </div>
          </div>
        </div>

        {showFilters && meta && (
          <div className="filters">
            <input className="filter-input" placeholder="Search…" value={search} onChange={e => setSearch(e.target.value)} />
            <select className="filter-select" value={fList} onChange={e => setFList(e.target.value)}>
              <option value="">All lists</option>
              {meta.lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            {meta.pillars.length > 0 && (
              <select className="filter-select" value={fPillar} onChange={e => setFPillar(e.target.value)}>
                <option value="">All pillars</option>
                {meta.pillars.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            )}
            <select className="filter-select" value={fStatus} onChange={e => setFStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="__open">Not done</option>
              <option value="__done">Done</option>
              {allStatuses.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="filter-select" value={fPriority} onChange={e => setFPriority(e.target.value)}>
              <option value="">All priorities</option>
              {PRIORITIES.map(p => <option key={p}>{p}</option>)}
            </select>
            <select className="filter-select" value={fOwner} onChange={e => setFOwner(e.target.value)}>
              <option value="">All owners</option>
              {meta.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            {anyBigSwing && (
              <select className="filter-select" value={fSwing} onChange={e => setFSwing(e.target.value)}>
                <option value="">All initiatives</option>
                <option value="yes">Big Swings only</option>
                <option value="no">Non-Big Swings</option>
              </select>
            )}
            {activeFilters > 0 && <button className="btn btn-ghost btn-sm" onClick={clearFilters}>Clear</button>}
          </div>
        )}

        {meta && view === 'calendar' && <Legend meta={meta} />}

        {view === 'list'
          ? <ListView items={scoped} onOpen={setSelectedId} onToggleDone={toggleDone} />
          : month
            ? <MonthView monthKey={month} items={filtered} onUpdate={updateItem} onOpen={setSelectedId} onAdd={d => setAddDefaults(d)} canRoadmapDate={canRoadmapDate} />
            : <YearView year={year} items={filtered} onOpenMonth={m => navigate({ year, month: m })} onOpenItem={setSelectedId} />}

        {selected && meta && <Drawer item={selected} meta={meta} monthAround={monthAround} onUpdate={updateItem} onArchive={archiveItem} onClose={() => setSelectedId(null)} />}
        {addDefaults && meta && <AddModal meta={meta} defaults={addDefaults} monthAround={monthAround} saving={pending > 0} onAdd={addItem} onClose={() => setAddDefaults(null)} />}
      </div>
    </ColorCtx.Provider>
  );
}

// ClickUp-backed data layer for the roadmap.
//
// The roadmap reads every list in a ClickUp folder (CLICKUP_FOLDER_ID), or an
// explicit set of lists (CLICKUP_LIST_IDS). Each list can have different
// statuses and custom fields, so everything is resolved per list.
//
// Native task fields: name, status, priority, assignees, start/due dates, description.
// Custom fields are found by NAME on each list (emoji/case/punctuation ignored;
// names configurable via env, comma-separated alternatives allowed):
//   Roadmap Start Date / Roadmap End Date — date fields. Used for placement ONLY
//                    when the task has no native start/due date.
//   Target Month   — month dropdown ("Nov 26") / text / date (alt: "Roadmap Month")
//   Pillar         — dropdown (optional)
//   Sprint         — dropdown or text (optional)
//   Big Swing      — checkbox (optional)
// Missing fields are simply hidden in the UI.
//
// Requests are tasks carrying the request tag (default "roadmap-request").
// Approving removes the tag; rejecting archives the task.

import type { Initiative, InitiativeInput, Member, RoadmapMeta, RoadmapRequest, FieldOption, StatusOption, ListMeta, FilterField } from './types';
import { parseMonthLabel, monthLabel } from './dates';
import { mockFetch } from './clickupMock';

const API = 'https://api.clickup.com/api/v2';
const LIST_COLORS = ['#4f6ef7', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16'];

const csv = (v: string | undefined) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

const env = {
  token: () => process.env.CLICKUP_API_TOKEN || '',
  mock: () => process.env.CLICKUP_MOCK === '1',
  folderId: () => process.env.CLICKUP_FOLDER_ID || '',
  listIds: () => csv(process.env.CLICKUP_LIST_IDS || process.env.CLICKUP_LIST_ID),
  defaultListId: () => process.env.CLICKUP_DEFAULT_LIST_ID || '',
  requestListId: () => process.env.CLICKUP_REQUEST_LIST_ID || '',
  teamId: () => process.env.CLICKUP_TEAM_ID || '',
  tz: () => process.env.ROADMAP_TIMEZONE || 'America/New_York',
  requestTag: () => (process.env.CLICKUP_REQUEST_TAG || 'roadmap-request').toLowerCase(),
  // Extra ClickUp fields offered as filters (dropdown, label or people fields), in display order
  filterFields: () => csv(process.env.CLICKUP_FILTER_FIELDS || 'ROCK,TACTIC,Task Category,Type of Request,Ready to Start?,Project Owner,Experiment Type,Size,Impact'),
  fieldNames: {
    pillar: () => csv(process.env.CLICKUP_FIELD_PILLAR || 'Pillar'),
    roadmapMonth: () => csv(process.env.CLICKUP_FIELD_ROADMAP_MONTH || 'Target Month,Roadmap Month'),
    roadmapStart: () => csv(process.env.CLICKUP_FIELD_ROADMAP_START || 'Roadmap Start Date,Roadmap Start'),
    roadmapEnd: () => csv(process.env.CLICKUP_FIELD_ROADMAP_END || 'Roadmap End Date,Roadmap End'),
    sprint: () => csv(process.env.CLICKUP_FIELD_SPRINT || 'Sprint'),
    testTargeting: () => csv(process.env.CLICKUP_FIELD_TEST_TARGETING || 'Test Targeting'),
    bigSwing: () => csv(process.env.CLICKUP_FIELD_BIG_SWING || 'Big Swing'),
  },
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// The app must NEVER change a task's native ClickUp start/due dates. Every write goes
// through cu(), so refuse any task payload that carries those fields.
const PROTECTED_TASK_KEYS = ['start_date', 'due_date', 'start_date_time', 'due_date_time'];
function assertNoNativeDates(path: string, method: string, body: unknown) {
  if (method === 'GET' || !body || typeof body !== 'object' || !/^\/(task|list)\//.test(path)) return;
  const hit = PROTECTED_TASK_KEYS.filter(k => k in (body as Record<string, unknown>));
  if (hit.length) throw new Error(`Refusing to modify ClickUp native task dates (${hit.join(', ')}). The roadmap only writes Roadmap Start/End Date.`);
}

async function cu<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  assertNoNativeDates(path, init.method || 'GET', init.body);
  if (env.mock()) return mockFetch(path, init) as Promise<T>;
  const token = env.token();
  if (!token) throw new Error('CLICKUP_API_TOKEN environment variable is not set');
  const res = await fetch(API + path, {
    method: init.method || 'GET',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { err: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`ClickUp ${res.status}: ${data.err || data.error || res.statusText}`);
  return data as T;
}

// ---------------------------------------------------------------------------
// Context (lists, statuses, fields, members) — cached 5 min
// ---------------------------------------------------------------------------

interface RawField { id: string; name: string; type: string; type_config?: { options?: Array<{ id: string; name?: string; label?: string; color?: string; orderindex?: number }> } }
type FieldKey = 'pillar' | 'roadmapMonth' | 'roadmapStart' | 'roadmapEnd' | 'sprint' | 'bigSwing' | 'testTargeting';

interface ListCtx {
  meta: ListMeta;
  fields: Partial<Record<FieldKey, RawField>>;
  attrFields: Array<{ label: string; field: RawField }>;
}

interface Ctx {
  lists: Map<string, ListCtx>;
  meta: RoadmapMeta;
}

let ctxCache: { at: number; ctx: Ctx } | null = null;
const CTX_TTL = 5 * 60 * 1000;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findField(fields: RawField[], names: string[]): RawField | undefined {
  for (const n of names.map(norm)) {
    const f = fields.find(f => norm(f.name) === n);
    if (f) return f;
  }
  return undefined;
}

function fieldOptions(f?: RawField): FieldOption[] {
  return (f?.type_config?.options || []).map(o => ({ id: o.id, name: o.name ?? o.label ?? '', color: o.color || '' }));
}

function toMember(u: any): Member {
  const name = u.username || u.email || String(u.id);
  return {
    id: Number(u.id),
    name,
    initials: u.initials || name.split(/\s+/).map((p: string) => p[0]).join('').slice(0, 2).toUpperCase(),
    color: u.color || '#6b7280',
  };
}

async function resolveListIds(): Promise<string[]> {
  // Mock mode always uses the built-in sample lists, whatever the real config says
  if (env.mock()) return ['mock-site', 'mock-sprint', 'mock-ab', 'mock-ideas'];
  const explicit = env.listIds();
  if (explicit.length) return explicit;
  const folder = env.folderId();
  if (folder) {
    const res = await cu<{ lists: Array<{ id: string; archived?: boolean }> }>(`/folder/${folder}/list?archived=false`);
    return (res.lists || []).filter(l => !l.archived).map(l => String(l.id));
  }
  throw new Error('Set CLICKUP_FOLDER_ID (or CLICKUP_LIST_IDS) to choose which ClickUp lists make up the roadmap');
}

async function loadList(id: string, idx: number): Promise<{ ctx: ListCtx; members: Member[] }> {
  const [list, fieldRes, memberRes] = await Promise.all([
    cu<any>(`/list/${id}`),
    cu<{ fields: RawField[] }>(`/list/${id}/field`),
    cu<{ members: any[] }>(`/list/${id}/member`).catch(() => ({ members: [] })),
  ]);
  const raw = fieldRes.fields || [];
  const fields: ListCtx['fields'] = {
    pillar: findField(raw, env.fieldNames.pillar()),
    roadmapMonth: findField(raw, env.fieldNames.roadmapMonth()),
    roadmapStart: findField(raw, env.fieldNames.roadmapStart()),
    roadmapEnd: findField(raw, env.fieldNames.roadmapEnd()),
    sprint: findField(raw, env.fieldNames.sprint()),
    testTargeting: findField(raw, env.fieldNames.testTargeting()),
    bigSwing: findField(raw, env.fieldNames.bigSwing()),
  };
  const attrFields = env.filterFields()
    .map(label => ({ label, field: findField(raw, [label]) }))
    .filter((x): x is { label: string; field: RawField } => !!x.field && ['drop_down', 'labels', 'users'].includes(x.field.type));
  const statuses: StatusOption[] = (list.statuses || []).map((s: any) => ({
    name: s.status, color: s.color || '#9ca3af', type: s.type, done: isDoneStatus(s.type, s.status),
  }));
  const rm = fields.roadmapMonth;
  const monthOptions = rm && ['drop_down', 'labels'].includes(rm.type)
    ? fieldOptions(rm).map(o => parseMonthLabel(o.name, new Date().getFullYear())).filter(Boolean)
    : [];
  const team = env.teamId();
  const meta: ListMeta = {
    id,
    name: list.name || id,
    url: team ? `https://app.clickup.com/${team}/v/li/${id}` : '',
    color: LIST_COLORS[idx % LIST_COLORS.length],
    statuses,
    fields: {
      pillar: !!fields.pillar, roadmapMonth: !!fields.roadmapMonth, roadmapStart: !!fields.roadmapStart, roadmapEnd: !!fields.roadmapEnd,
      sprint: !!fields.sprint, bigSwing: !!fields.bigSwing, testTargeting: !!fields.testTargeting,
    },
    pillars: fieldOptions(fields.pillar),
    sprintOptions: fields.sprint && ['drop_down', 'labels'].includes(fields.sprint.type) ? fieldOptions(fields.sprint) : [],
    monthOptions,
  };
  return { ctx: { meta, fields, attrFields }, members: (memberRes.members || []).map(toMember) };
}

async function getCtx(force = false): Promise<Ctx> {
  if (!force && ctxCache && Date.now() - ctxCache.at < CTX_TTL) return ctxCache.ctx;
  const ids = await resolveListIds();
  if (!ids.length) throw new Error('No ClickUp lists found for the roadmap');
  const loaded = await Promise.all(ids.map((id, i) => loadList(id, i)));
  const lists = new Map(loaded.map(l => [l.ctx.meta.id, l.ctx]));

  const members = new Map<number, Member>();
  loaded.forEach(l => l.members.forEach(m => members.set(m.id, m)));
  const pillars = new Map<string, FieldOption>();
  loaded.forEach(l => l.ctx.meta.pillars.forEach(p => { if (!pillars.has(p.name)) pillars.set(p.name, p); }));

  // Filter fields: union of options across the lists that have each field
  const filterFields: FilterField[] = [];
  for (const label of env.filterFields()) {
    const holders = loaded.filter(l => l.ctx.attrFields.some(a => a.label === label));
    if (!holders.length) continue;
    const opts = new Map<string, FieldOption>();
    for (const h of holders) {
      const a = h.ctx.attrFields.find(x => x.label === label)!;
      if (a.field.type === 'users') h.members.forEach(m => { if (!opts.has(m.name)) opts.set(m.name, { id: String(m.id), name: m.name, color: m.color }); });
      else fieldOptions(a.field).forEach(o => { if (o.name && !opts.has(o.name)) opts.set(o.name, o); });
    }
    filterFields.push({ label, options: Array.from(opts.values()), lists: holders.map(h => h.ctx.meta.id) });
  }

  const pick = (want: string) => (want && lists.has(want) ? want : ids[0]);
  const defaultListId = pick(env.defaultListId());
  const meta: RoadmapMeta = {
    lists: loaded.map(l => l.ctx.meta),
    filterFields,
    defaultListId,
    requestListId: env.requestListId() && lists.has(env.requestListId()) ? env.requestListId() : defaultListId,
    pillars: Array.from(pillars.values()),
    members: Array.from(members.values()).sort((a, b) => a.name.localeCompare(b.name)),
    mock: env.mock(),
  };
  const ctx = { lists, meta };
  ctxCache = { at: Date.now(), ctx };
  return ctx;
}

export async function getMeta(): Promise<RoadmapMeta> {
  return (await getCtx()).meta;
}

function listCtx(ctx: Ctx, listId: string): ListCtx {
  const l = ctx.lists.get(listId);
  if (!l) throw new Error(`List ${listId} is not part of the roadmap`);
  return l;
}

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function msToDate(ms: string | number | null | undefined): string {
  if (ms === null || ms === undefined || ms === '') return '';
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.tz(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Date-only → 17:00 UTC (midday in every US timezone), so the calendar day never shifts. */
function dateToMs(d: string): number | null {
  if (!d) return null;
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day, 17, 0, 0);
}

/** Closed/done status types, plus custom statuses that are named as done (e.g. "done (this sprint)"). */
const isDoneStatus = (type: string | undefined, name: string | undefined) =>
  type === 'closed' || type === 'done' || /\b(done|complete|completed|shipped|launched)\b/i.test(name || '');

const PRIORITY_FROM_CU: Record<string, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };
const PRIORITY_TO_CU: Record<string, number> = { Urgent: 1, High: 2, Normal: 3, Low: 4 };

function optionFor(field: RawField, value: unknown): FieldOption | undefined {
  const opts = field.type_config?.options || [];
  const isIndex = typeof value === 'number' || /^\d+$/.test(String(value));
  const o = opts.find(o => o.id === value) || (isIndex ? opts.find(o => o.orderindex === Number(value)) : undefined);
  return o ? { id: o.id, name: o.name ?? o.label ?? '', color: o.color || '' } : undefined;
}

function rawValue(field: RawField | undefined, task: any): unknown {
  if (!field) return undefined;
  return (task.custom_fields || []).find((c: any) => c.id === field.id)?.value;
}

function fieldText(field: RawField | undefined, task: any): string {
  const v = rawValue(field, task);
  if (!field || v === undefined || v === null || v === '') return '';
  switch (field.type) {
    case 'drop_down': return optionFor(field, v)?.name || '';
    case 'labels': return Array.isArray(v) ? (optionFor(field, v[0])?.name || '') : '';
    case 'date': return msToDate(v as string);
    default: return String(v);
  }
}

function readRoadmapMonth(field: RawField | undefined, task: any, hint: string): string {
  const text = fieldText(field, task);
  if (!field || !text) return '';
  if (field.type === 'date') return text.slice(0, 7);
  const fallbackYear = Number(hint.slice(0, 4)) || new Date().getFullYear();
  return parseMonthLabel(text, fallbackYear);
}

/** Value to POST for a custom field from a display value. undefined = clear. */
function fieldValueFor(field: RawField, display: string, kind: 'month' | 'date' | 'plain'): unknown {
  if (!display) return undefined;
  switch (field.type) {
    case 'drop_down':
    case 'labels': {
      const opts = fieldOptions(field);
      const match = kind === 'month'
        ? opts.find(o => parseMonthLabel(o.name, Number(display.slice(0, 4))) === display)
        : opts.find(o => o.name === display || o.id === display);
      if (!match) throw new Error(`"${kind === 'month' ? monthLabel(display) : display}" isn't an option on the ClickUp field "${field.name}"`);
      return field.type === 'labels' ? [match.id] : match.id;
    }
    case 'date':
      return dateToMs(kind === 'month' ? `${display}-01` : display);
    case 'number':
      return Number(display);
    default:
      return kind === 'month' ? monthLabel(display) : display;
  }
}

async function setField(taskId: string, field: RawField | undefined, value: unknown) {
  if (!field) return;
  if (value === undefined || value === null || value === '') {
    await cu(`/task/${taskId}/field/${field.id}`, { method: 'DELETE' });
  } else if (field.type === 'date') {
    await cu(`/task/${taskId}/field/${field.id}`, { method: 'POST', body: { value, value_options: { time: false } } });
  } else {
    await cu(`/task/${taskId}/field/${field.id}`, { method: 'POST', body: { value } });
  }
}

function mapTask(task: any, l: ListCtx): Initiative {
  const start = msToDate(task.start_date);
  const due = msToDate(task.due_date);
  const roadmapStart = fieldText(l.fields.roadmapStart, task);
  const roadmapEnd = fieldText(l.fields.roadmapEnd, task);
  const t = task.status?.type;
  return {
    id: task.id,
    name: task.name || '',
    url: task.url || '',
    listId: l.meta.id,
    listName: l.meta.name,
    status: task.status?.status || '',
    statusColor: task.status?.color || '#9ca3af',
    done: isDoneStatus(t, task.status?.status),
    priority: PRIORITY_FROM_CU[task.priority?.priority] || '',
    pillar: fieldText(l.fields.pillar, task),
    bigSwing: rawValue(l.fields.bigSwing, task) === true || rawValue(l.fields.bigSwing, task) === 'true',
    roadmapMonth: readRoadmapMonth(l.fields.roadmapMonth, task, start || due || roadmapStart || roadmapEnd),
    roadmapStart,
    roadmapEnd,
    sprint: fieldText(l.fields.sprint, task),
    testTargeting: fieldText(l.fields.testTargeting, task),
    startDate: start,
    dueDate: due,
    owners: (task.assignees || []).map(toMember),
    notes: task.markdown_description ?? task.text_content ?? task.description ?? '',
    tags: (task.tags || []).map((x: any) => String(x.name).toLowerCase()),
    createdAt: task.date_created ? new Date(Number(task.date_created)).toISOString() : '',
    attrs: readAttrs(l, task),
  };
}

/** Values of the filterable fields: option names for dropdown/labels, people names for users fields. */
function readAttrs(l: ListCtx, task: any): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const { label, field } of l.attrFields) {
    const v = rawValue(field, task);
    if (v === undefined || v === null || v === '') continue;
    let names: string[] = [];
    if (field.type === 'drop_down') names = [optionFor(field, v)?.name || ''];
    else if (field.type === 'labels' && Array.isArray(v)) names = v.map(x => optionFor(field, x)?.name || '');
    else if (field.type === 'users' && Array.isArray(v)) names = v.map((u: any) => u.username || u.email || String(u.id));
    names = names.filter(Boolean);
    if (names.length) out[label] = names;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tasks — short cache so the board stays fast and well under function timeouts
// ---------------------------------------------------------------------------

let taskCache: { at: number; items: Initiative[] } | null = null;
const TASK_TTL = 20 * 1000;
const invalidate = () => { taskCache = null; };

async function fetchListTasks(l: ListCtx): Promise<Initiative[]> {
  const out: Initiative[] = [];
  for (let page = 0; page < 20; page++) {
    const res = await cu<{ tasks: any[]; last_page?: boolean }>(
      `/list/${l.meta.id}/task?page=${page}&include_closed=true&subtasks=false&include_markdown_description=true`
    );
    out.push(...(res.tasks || []).map(t => mapTask(t, l)));
    if (res.last_page !== false || !res.tasks?.length) break;
  }
  return out;
}

async function getAllItems(): Promise<Initiative[]> {
  if (taskCache && Date.now() - taskCache.at < TASK_TTL) return taskCache.items;
  const ctx = await getCtx();
  const perList = await Promise.all(Array.from(ctx.lists.values()).map(fetchListTasks));
  const seen = new Set<string>();
  const items = perList.flat().filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  taskCache = { at: Date.now(), items };
  return items;
}

async function getOne(id: string, ctx?: Ctx): Promise<Initiative> {
  ctx ||= await getCtx();
  const task = await cu<any>(`/task/${id}?include_markdown_description=true`);
  return mapTask(task, listCtx(ctx, String(task.list?.id)));
}

// ---------------------------------------------------------------------------
// Initiatives
// ---------------------------------------------------------------------------

export async function getInitiatives(): Promise<Initiative[]> {
  const tag = env.requestTag();
  return (await getAllItems()).filter(i => !i.tags.includes(tag));
}

export async function addInitiative(input: InitiativeInput & { name: string }, extraTags: string[] = []): Promise<Initiative> {
  const ctx = await getCtx();
  const l = listCtx(ctx, input.listId || ctx.meta.defaultListId);
  const f = l.fields;
  const custom_fields: Array<{ id: string; value: unknown; value_options?: unknown }> = [];
  const push = (field: RawField | undefined, display: string | undefined, kind: 'month' | 'date' | 'plain') => {
    if (!field || !display) return;
    const value = fieldValueFor(field, display, kind);
    if (value !== undefined) custom_fields.push(field.type === 'date' ? { id: field.id, value, value_options: { time: false } } : { id: field.id, value });
  };
  push(f.pillar, input.pillar, 'plain');
  push(f.roadmapMonth, input.roadmapMonth, 'month');
  push(f.roadmapStart, input.roadmapStart, 'date');
  push(f.roadmapEnd, input.roadmapEnd, 'date');
  push(f.sprint, input.sprint, 'plain');
  push(f.testTargeting, input.testTargeting, 'plain');
  if (f.bigSwing && input.bigSwing) custom_fields.push({ id: f.bigSwing.id, value: true });

  const body: Record<string, unknown> = {
    name: input.name,
    markdown_content: input.notes || '',
    priority: input.priority ? PRIORITY_TO_CU[input.priority] ?? null : null,
    assignees: input.ownerId ? [input.ownerId] : [],
    tags: extraTags,
    custom_fields,
  };
  if (input.status && l.meta.statuses.some(s => s.name === input.status)) body.status = input.status;

  const created = await cu<any>(`/list/${l.meta.id}/task`, { method: 'POST', body });
  invalidate();
  return getOne(created.id, ctx);
}

export async function updateInitiative(id: string, input: InitiativeInput): Promise<Initiative> {
  if ('startDate' in input || 'dueDate' in input) {
    throw new Error('The roadmap never changes ClickUp start/due dates — use Roadmap Start/End Date.');
  }
  const ctx = await getCtx();
  const current = await cu<any>(`/task/${id}`);
  const f = listCtx(ctx, String(current.list?.id)).fields;

  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.status !== undefined) body.status = input.status;
  if (input.priority !== undefined) body.priority = input.priority ? PRIORITY_TO_CU[input.priority] ?? null : null;
  if (input.notes !== undefined) body.markdown_content = input.notes;
  if (input.ownerId !== undefined) {
    const rem = (current.assignees || []).map((a: any) => Number(a.id)).filter((x: number) => x !== input.ownerId);
    body.assignees = { add: input.ownerId ? [input.ownerId] : [], rem };
  }
  if (Object.keys(body).length) await cu(`/task/${id}`, { method: 'PUT', body });

  if (input.pillar !== undefined && f.pillar) await setField(id, f.pillar, fieldValueFor(f.pillar, input.pillar, 'plain'));
  if (input.roadmapMonth !== undefined && f.roadmapMonth) await setField(id, f.roadmapMonth, fieldValueFor(f.roadmapMonth, input.roadmapMonth, 'month'));
  if (input.roadmapStart !== undefined && f.roadmapStart) await setField(id, f.roadmapStart, fieldValueFor(f.roadmapStart, input.roadmapStart, 'date'));
  if (input.roadmapEnd !== undefined && f.roadmapEnd) await setField(id, f.roadmapEnd, fieldValueFor(f.roadmapEnd, input.roadmapEnd, 'date'));
  if (input.sprint !== undefined && f.sprint) await setField(id, f.sprint, fieldValueFor(f.sprint, input.sprint, 'plain'));
  if (input.testTargeting !== undefined && f.testTargeting) await setField(id, f.testTargeting, fieldValueFor(f.testTargeting, input.testTargeting.trim(), 'plain'));
  if (input.bigSwing !== undefined && f.bigSwing) await cu(`/task/${id}/field/${f.bigSwing.id}`, { method: 'POST', body: { value: input.bigSwing } });

  invalidate();
  return getOne(id, ctx);
}

/** "Remove" from the roadmap = archive in ClickUp (reversible), never a hard delete. */
export async function archiveInitiative(id: string): Promise<void> {
  await cu(`/task/${id}`, { method: 'PUT', body: { archived: true } });
  invalidate();
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const REQ_PREFIX = '**Requested by:** ';

export async function getRequests(): Promise<RoadmapRequest[]> {
  const tag = env.requestTag();
  return (await getAllItems())
    .filter(i => i.tags.includes(tag))
    .map(i => {
      const lines = i.notes.split('\n');
      const by = lines[0]?.startsWith(REQ_PREFIX) ? lines[0].slice(REQ_PREFIX.length).trim() : '';
      return {
        id: i.id,
        name: i.name,
        pillar: i.pillar,
        month: i.roadmapMonth ? monthLabel(i.roadmapMonth) : '',
        priority: i.priority,
        submittedBy: by,
        notes: by ? lines.slice(1).join('\n').trim() : i.notes,
        submittedAt: i.createdAt,
        url: i.url,
      };
    })
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

export async function addRequest(r: { name: string; pillar?: string; month?: string; priority?: string; submittedBy: string; notes?: string }) {
  const ctx = await getCtx();
  const l = listCtx(ctx, ctx.meta.requestListId);
  let month = l.fields.roadmapMonth ? r.month : undefined;
  if (month && l.meta.monthOptions.length && !l.meta.monthOptions.includes(month)) month = undefined;
  return addInitiative({
    listId: l.meta.id,
    name: r.name,
    pillar: l.fields.pillar ? r.pillar : undefined,
    roadmapMonth: month,
    priority: r.priority,
    notes: `${REQ_PREFIX}${r.submittedBy}\n\n${r.notes || ''}`.trim(),
  }, [env.requestTag()]);
}

export async function approveRequest(id: string): Promise<Initiative> {
  await cu(`/task/${id}/tag/${encodeURIComponent(env.requestTag())}`, { method: 'DELETE' });
  invalidate();
  return getOne(id);
}

export async function rejectRequest(id: string): Promise<void> {
  await archiveInitiative(id);
}

export function verifyApproverPassword(password: string): boolean {
  const stored = process.env.APPROVER_PASSWORD;
  return !!stored && password === stored;
}

// ---------------------------------------------------------------------------
// Config page
// ---------------------------------------------------------------------------

export async function testConnection() {
  const base = {
    mock: env.mock(),
    hasToken: !!env.token(),
    source: env.listIds().length ? `Lists: ${env.listIds().join(', ')}` : env.folderId() ? `Folder ${env.folderId()}` : env.mock() ? 'Mock data' : 'Not set',
    hasApproverPassword: !!process.env.APPROVER_PASSWORD,
    timezone: env.tz(),
    requestTag: env.requestTag(),
  };
  try {
    const ctx = await getCtx(true);
    invalidate();
    const items = await getAllItems();
    const counts: Record<string, number> = {};
    items.forEach(i => { counts[i.listId] = (counts[i.listId] || 0) + 1; });
    return {
      ...base,
      success: true,
      message: `Connected — ${ctx.meta.lists.length} list${ctx.meta.lists.length === 1 ? '' : 's'}, ${items.length} tasks`,
      lists: ctx.meta.lists.map(l => ({ id: l.id, name: l.name, fields: l.fields, statuses: l.statuses.length, tasks: counts[l.id] || 0 })),
      defaultListId: ctx.meta.defaultListId,
      requestListId: ctx.meta.requestListId,
    };
  } catch (err: any) {
    return { ...base, success: false, message: err.message || 'Unknown error' };
  }
}

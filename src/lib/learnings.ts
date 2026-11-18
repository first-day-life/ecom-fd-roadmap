// Test learnings — the A/B test learnings repository.
//
// Stored as tasks in a ClickUp list OUTSIDE the roadmap folder, so they never appear on
// the roadmap. The list is CLICKUP_LEARNINGS_LIST_ID, or else a folderless list named
// "Test Learnings" in the roadmap folder's space.
//
// Each task:
//   name           = title
//   custom fields  = the structured data, found by name ("abtest-" prefix optional):
//     dropdowns  outcome · quarter · rollout
//     labels     pagetype · lever · product · metric
//     text       dates · hypothesis · result · learning · nextsteps
//     urls       slide · intelligems · intelligemsresults
//   description    = optional header lines (Link / Intelligems / Tags / Added by), then notes.
//                    Older learnings keep their tags there; the app no longer writes tags.
// Only task name/description and these custom fields are written — never dates.

import { cu } from './clickup';

export const SELECT_KEYS = ['outcome', 'quarter', 'rollout'] as const;
export const LABEL_KEYS = ['pageType', 'lever', 'product', 'metric'] as const;
export const TEXT_KEYS = ['dates', 'hypothesis', 'result', 'learning', 'nextSteps'] as const;
export const URL_KEYS = ['slide', 'intelligems', 'intelligemsResults'] as const;
type SelectKey = typeof SELECT_KEYS[number];
type LabelKey = typeof LABEL_KEYS[number];
type TextKey = typeof TEXT_KEYS[number];
type UrlKey = typeof URL_KEYS[number];
type FieldKey = SelectKey | LabelKey | TextKey | UrlKey;
const ALL_KEYS: FieldKey[] = [...SELECT_KEYS, ...LABEL_KEYS, ...TEXT_KEYS, ...URL_KEYS];

export interface LearningFields {
  outcome: string; quarter: string; rollout: string;
  pageType: string[]; lever: string[]; product: string[]; metric: string[];
  dates: string; hypothesis: string; result: string; learning: string; nextSteps: string;
  slide: string; intelligems: string; intelligemsResults: string;
}
export interface Learning extends LearningFields {
  id: string;
  title: string;
  link: string;        // legacy description "Link:" line
  tags: string[];      // legacy description "Tags:" line
  notes: string;
  addedBy: string;
  createdAt: string;   // ISO
  clickupUrl: string;
}
export type LearningInput = { title: string; notes?: string } & Partial<LearningFields>;
/** Choices for each select/label field, in ClickUp's order. Empty when the field doesn't exist on the list. */
export type LearningOptions = Record<SelectKey | LabelKey, string[]>;

const LINK = '**Link:** ', IG = '**Intelligems:** ', TAGS = '**Tags:** ', BY = '**Added by:** ';
const norm = (s: string) => s.toLowerCase().replace(/^ab\s*test[\s_-]*/i, '').replace(/[^a-z0-9]+/g, '');
const mock = () => process.env.CLICKUP_MOCK === '1';

const emptyFields = (): LearningFields => ({
  outcome: '', quarter: '', rollout: '', pageType: [], lever: [], product: [], metric: [],
  dates: '', hypothesis: '', result: '', learning: '', nextSteps: '', slide: '', intelligems: '', intelligemsResults: '',
});

// --- ClickUp field definitions for the learnings list (cached 5 min) ---
interface RawField { id: string; name: string; type: string; type_config?: { options?: Array<{ id: string; name?: string; label?: string; orderindex?: number }> } }
type FieldMap = Partial<Record<FieldKey, RawField>>;
let defsCache: { at: number; listId: string; map: FieldMap } | null = null;

async function fieldDefs(listId: string): Promise<FieldMap> {
  if (defsCache && defsCache.listId === listId && Date.now() - defsCache.at < 5 * 60 * 1000) return defsCache.map;
  const res = await cu<{ fields: RawField[] }>(`/list/${listId}/field`);
  const map: FieldMap = {};
  for (const k of ALL_KEYS) {
    const f = (res.fields || []).find(x => norm(x.name) === k.toLowerCase());
    if (f) map[k] = f;
  }
  defsCache = { at: Date.now(), listId, map };
  return map;
}
const optName = (o: { name?: string; label?: string }) => String(o.name ?? o.label ?? '');

function optionsOf(map: FieldMap): LearningOptions {
  const out = {} as LearningOptions;
  for (const k of [...SELECT_KEYS, ...LABEL_KEYS]) out[k] = (map[k]?.type_config?.options || []).map(optName).filter(Boolean);
  return out;
}

/** Read a task's custom fields into named values (dropdown index / label ids → option names). */
function readFields(task: any, map: FieldMap): LearningFields {
  const f = emptyFields();
  const byId = new Map<string, any>((task.custom_fields || []).map((c: any) => [c.id, c]));
  for (const k of ALL_KEYS) {
    const def = map[k];
    const c = def && byId.get(def.id);
    if (!c || c.value == null || c.value === '') continue;
    const opts = def!.type_config?.options || [];
    if ((SELECT_KEYS as readonly string[]).includes(k)) {
      const o = opts.find(o => o.orderindex === Number(c.value)) || opts.find(o => o.id === c.value);
      (f as any)[k] = o ? optName(o) : '';
    } else if ((LABEL_KEYS as readonly string[]).includes(k)) {
      (f as any)[k] = (Array.isArray(c.value) ? c.value : []).map((id: string) => opts.find(o => o.id === id)).filter(Boolean).map(optName);
    } else {
      (f as any)[k] = String(c.value).trim();
    }
  }
  return f;
}

/** Turn input values into ClickUp field values (option names → option ids). Unknown option names are dropped. */
function toFieldValues(input: Partial<LearningFields>, map: FieldMap): Array<{ id: string; value: any; clear: boolean }> {
  const out: Array<{ id: string; value: any; clear: boolean }> = [];
  for (const k of ALL_KEYS) {
    if (!(k in input)) continue;
    const def = map[k];
    if (!def) continue;
    const v = (input as any)[k];
    const opts = def.type_config?.options || [];
    const find = (name: string) => opts.find(o => optName(o).toLowerCase() === String(name).toLowerCase());
    if ((SELECT_KEYS as readonly string[]).includes(k)) {
      const o = v ? find(v) : undefined;
      out.push(o ? { id: def.id, value: o.id, clear: false } : { id: def.id, value: null, clear: true });
    } else if ((LABEL_KEYS as readonly string[]).includes(k)) {
      const ids = (Array.isArray(v) ? v : []).map(find).filter(Boolean).map(o => o!.id);
      out.push(ids.length ? { id: def.id, value: ids, clear: false } : { id: def.id, value: null, clear: true });
    } else {
      const s = String(v ?? '').trim();
      out.push(s ? { id: def.id, value: s, clear: false } : { id: def.id, value: null, clear: true });
    }
  }
  return out;
}

export function cleanTags(tags: unknown): string[] {
  const arr = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const out: string[] = [];
  for (const t of arr) {
    const v = String(t).trim().replace(/^#/, '').toLowerCase().slice(0, 40);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 20);
}

/** "[label](url)" or "<url>" or "url" → url */
const bareUrl = (s: string) => s.trim().replace(/\\_/g, '_').replace(/^<|>$/g, '').replace(/^\[.*?\]\((.*)\)$/, '$1');

function fromTask(t: any, map: FieldMap): Learning {
  const lines = String(t.markdown_description ?? t.text_content ?? t.description ?? '').split('\n');
  let link = '', igLine = '', tags: string[] = [], addedBy = '', n = 0;
  for (; n < lines.length; n++) {
    const l = lines[n].trim();
    if (l.startsWith(LINK)) link = bareUrl(l.slice(LINK.length));
    else if (l.startsWith(IG)) igLine = bareUrl(l.slice(IG.length));
    else if (l.startsWith(TAGS)) tags = cleanTags(l.slice(TAGS.length));
    else if (l.startsWith(BY)) addedBy = l.slice(BY.length).trim();
    else break;
  }
  const f = readFields(t, map);
  if (!f.intelligemsResults && !f.intelligems && igLine) f.intelligems = igLine;
  return {
    id: String(t.id),
    title: String(t.name || ''),
    ...f,
    link, tags, addedBy,
    notes: lines.slice(n).join('\n').trim(),
    createdAt: t.date_created ? new Date(Number(t.date_created)).toISOString() : '',
    clickupUrl: t.url || '',
  };
}

// --- mock store (CLICKUP_MOCK=1) ---
const MOCK_OPTIONS: LearningOptions = {
  outcome: ['winner', 'loser', 'flat', 'mixed', 'inconclusive'],
  quarter: ['2026-q1', '2026-q2', '2026-q3', '2026-q4'],
  rollout: ['rolled-out', 'not-rolled-out'],
  pageType: ['homepage', 'pdp', 'sale-page', 'lp', 'cart', 'checkout', 'navigation', 'search'],
  lever: ['offer', 'pricing', 'subscription', 'upsell', 'bundle', 'social-proof', 'trust', 'copy', 'creative', 'layout', 'open-funnel', '90-day'],
  product: ['kde', 'tdk', 'kcm', 'wds'],
  metric: ['CVR', 'RPV', 'AOV', 'ATC rate', 'Sub opt-in', 'Checkout completion', 'Upsell take rate', 'Click-through', 'ROAS', 'LTV', 'Abandoned cart'],
};
const g = globalThis as any;
function mockStore(): Learning[] {
  const base = (o: Partial<Learning>): Learning => ({ ...emptyFields(), id: '', title: '', link: '', tags: [], notes: '', addedBy: 'sample', createdAt: '', clickupUrl: '', ...o });
  return (g.__learnMock2 ||= [
    base({ id: 'l1', title: 'Reviews + ratings on sale-page tiles: CVR +10%, RPV +12%', outcome: 'winner', rollout: 'rolled-out', quarter: '2026-q3', pageType: ['sale-page'], lever: ['social-proof', 'trust'], metric: ['CVR', 'RPV'], dates: '9/2 – 9/16/2026', hypothesis: 'Showing star rating and review count on tiles builds trust for cold Meta traffic.', result: 'CVR +10%, RPV +12%, AOV flat.', learning: 'Social proof on tiles builds confidence for mostly-cold visitors from Meta ads.', nextSteps: 'Roll out V2 (rating below price).', slide: 'https://docs.google.com/presentation/d/x/edit#slide=id.a', createdAt: '2026-10-02T15:00:00Z' }),
    base({ id: 'l2', title: 'Removing LP benefits marquee: RPV −16%, keep the module', outcome: 'loser', rollout: 'not-rolled-out', quarter: '2026-q2', pageType: ['lp'], lever: ['layout', 'copy'], product: ['kde'], metric: ['RPV'], dates: '4/1 – 4/7/2026', result: 'RPV −16% (stat sig).', learning: 'The benefits marquee helps even on a text-heavy LP.', nextSteps: 'Keep and rebuild on Shopify.', slide: 'https://docs.google.com/presentation/d/x/edit#slide=id.b', createdAt: '2026-10-20T15:00:00Z' }),
    base({ id: 'l3', title: 'Site search: flat, do not roll out', outcome: 'flat', rollout: 'not-rolled-out', quarter: '2026-q2', pageType: ['search', 'navigation'], lever: ['layout'], metric: ['CVR'], dates: '6/16 – 6/26/2026', result: 'No measurable benefit; 0.5% search use.', learning: 'Search is barely used on a small catalog.', intelligems: 'https://app.intelligems.io/experiment/abc', createdAt: '2026-11-05T15:00:00Z' }),
  ]);
}

let listCache: string | null = null;
async function listId(): Promise<string> {
  if (process.env.CLICKUP_LEARNINGS_LIST_ID) return process.env.CLICKUP_LEARNINGS_LIST_ID;
  if (listCache) return listCache;
  const folder = process.env.CLICKUP_FOLDER_ID;
  if (!folder) throw new Error('Set CLICKUP_LEARNINGS_LIST_ID to the ClickUp list that stores test learnings');
  const f = await cu<any>(`/folder/${folder}`);
  const res = await cu<{ lists: any[] }>(`/space/${f.space.id}/list?archived=false`);
  const l = (res.lists || []).find(x => x.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === 'test learnings');
  if (!l) throw new Error('No "Test Learnings" list found — create one in the roadmap’s ClickUp space, or set CLICKUP_LEARNINGS_LIST_ID');
  return (listCache = String(l.id));
}

/** Throws unless the task is in the learnings list — the API can't be used to edit roadmap tasks. */
async function assertLearning(id: string, lid: string): Promise<any> {
  const t = await cu<any>(`/task/${encodeURIComponent(id)}?include_markdown_description=true`);
  if (String(t.list?.id) !== lid) throw new Error('Not a learning');
  return t;
}

export async function getLearnings(): Promise<{ learnings: Learning[]; options: LearningOptions }> {
  if (mock()) return { learnings: [...mockStore()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), options: MOCK_OPTIONS };
  const id = await listId();
  const map = await fieldDefs(id);
  const out: Learning[] = [];
  for (let page = 0; page < 20; page++) {
    const res = await cu<{ tasks: any[]; last_page?: boolean }>(`/list/${id}/task?page=${page}&include_closed=true&subtasks=false&include_markdown_description=true`);
    out.push(...(res.tasks || []).map(t => fromTask(t, map)));
    if (res.last_page || !(res.tasks || []).length) break;
  }
  return { learnings: out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), options: optionsOf(map) };
}

function descFor(notes: string, addedBy: string): string {
  return [addedBy ? `${BY}${addedBy}` : '', notes ? `\n${notes}` : ''].filter(Boolean).join('\n').trim();
}

async function writeFields(taskId: string, vals: Array<{ id: string; value: any; clear: boolean }>) {
  for (const v of vals) {
    if (v.clear) await cu(`/task/${encodeURIComponent(taskId)}/field/${v.id}`, { method: 'DELETE' }).catch(() => undefined);
    else await cu(`/task/${encodeURIComponent(taskId)}/field/${v.id}`, { method: 'POST', body: { value: v.value } });
  }
}

export async function addLearning(i: LearningInput, addedBy: string): Promise<Learning> {
  if (mock()) {
    const l: Learning = { ...emptyFields(), ...(i as any), id: 'l' + Date.now(), link: '', tags: [], notes: i.notes || '', addedBy, createdAt: new Date().toISOString(), clickupUrl: '' };
    mockStore().push(l);
    return l;
  }
  const lid = await listId();
  const map = await fieldDefs(lid);
  const vals = toFieldValues(i, map).filter(v => !v.clear);
  const t = await cu<any>(`/list/${lid}/task`, {
    method: 'POST',
    body: { name: i.title, markdown_content: descFor(i.notes || '', addedBy), custom_fields: vals.map(v => ({ id: v.id, value: v.value })) },
  });
  return fromTask(await cu<any>(`/task/${t.id}?include_markdown_description=true`), map);
}

export async function updateLearning(id: string, i: LearningInput): Promise<Learning> {
  if (mock()) {
    const s = mockStore(); const k = s.findIndex(x => x.id === id);
    if (k < 0) throw new Error('Not found');
    return (s[k] = { ...s[k], ...(i as any) });
  }
  const lid = await listId();
  const map = await fieldDefs(lid);
  const cur = fromTask(await assertLearning(id, lid), map);
  await cu(`/task/${encodeURIComponent(id)}`, { method: 'PUT', body: { name: i.title } });
  // Only write fields whose value actually changed
  const changed: Partial<LearningFields> = {};
  for (const k of ALL_KEYS) {
    if (!(k in i)) continue;
    if (JSON.stringify((i as any)[k] ?? '') !== JSON.stringify((cur as any)[k] ?? '')) (changed as any)[k] = (i as any)[k];
  }
  await writeFields(id, toFieldValues(changed, map));
  return fromTask(await cu<any>(`/task/${encodeURIComponent(id)}?include_markdown_description=true`), map);
}

/** Archives (not deletes) the ClickUp task — it can be restored in ClickUp. */
export async function archiveLearning(id: string): Promise<void> {
  if (mock()) { g.__learnMock2 = mockStore().filter(x => x.id !== id); return; }
  await assertLearning(id, await listId());
  await cu(`/task/${encodeURIComponent(id)}`, { method: 'PUT', body: { archived: true } });
}

/** Pick known field values out of an untrusted request body. */
export function inputFromBody(b: any): LearningInput {
  const out: any = { title: String(b.title || '').trim().slice(0, 200) };
  for (const k of [...SELECT_KEYS, ...TEXT_KEYS]) if (k in b) out[k] = String(b[k] ?? '').slice(0, 5000);
  for (const k of URL_KEYS) if (k in b) out[k] = String(b[k] ?? '').trim().slice(0, 1000);
  for (const k of LABEL_KEYS) if (k in b) out[k] = (Array.isArray(b[k]) ? b[k] : []).map((x: any) => String(x)).slice(0, 20);
  return out;
}
export function badUrl(i: LearningInput): string {
  for (const k of URL_KEYS) { const v = (i as any)[k]; if (v && !/^https?:\/\//i.test(v)) return `${k} must start with http:// or https://`; }
  return '';
}

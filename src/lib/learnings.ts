// Test learnings — a running, tagged list of links (test readouts, decks, docs).
//
// Stored as tasks in a ClickUp list OUTSIDE the roadmap folder, so they never appear on
// the roadmap. The list is CLICKUP_LEARNINGS_LIST_ID, or else a folderless list named
// "Test Learnings" in the roadmap folder's space. Each task:
//   name        = title
//   description = header lines (Link / Tags / Added by), a blank line, then notes
// Tags live in the description, not as ClickUp tags, so the shared space tag list stays clean.
// Only task name/description are written — never dates.

import { cu } from './clickup';

export interface Learning {
  id: string;
  title: string;
  link: string;
  tags: string[];
  notes: string;
  addedBy: string;
  createdAt: string;   // ISO
  clickupUrl: string;
}
export type LearningInput = { title: string; link: string; tags: string[]; notes: string };

const LINK = '**Link:** ', TAGS = '**Tags:** ', BY = '**Added by:** ';
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const mock = () => process.env.CLICKUP_MOCK === '1';

export function cleanTags(tags: unknown): string[] {
  const arr = Array.isArray(tags) ? tags : String(tags || '').split(',');
  const out: string[] = [];
  for (const t of arr) {
    const v = String(t).trim().replace(/^#/, '').toLowerCase().slice(0, 40);
    if (v && !out.includes(v)) out.push(v);
  }
  return out.slice(0, 20);
}

function toMarkdown(i: LearningInput, addedBy: string): string {
  return [`${LINK}${i.link}`, `${TAGS}${i.tags.join(', ')}`, addedBy ? `${BY}${addedBy}` : '', '', i.notes || '']
    .filter((l, n) => n >= 3 || l).join('\n').trim();
}

function fromTask(t: any): Learning {
  const lines = String(t.markdown_description ?? t.text_content ?? t.description ?? '').split('\n');
  let link = '', tags: string[] = [], addedBy = '', n = 0;
  for (; n < lines.length; n++) {
    const l = lines[n].trim();
    if (l.startsWith(LINK)) link = l.slice(LINK.length).trim().replace(/^<|>$/g, '').replace(/^\[.*?\]\((.*)\)$/, '$1');
    else if (l.startsWith(TAGS)) tags = cleanTags(l.slice(TAGS.length));
    else if (l.startsWith(BY)) addedBy = l.slice(BY.length).trim();
    else break;
  }
  return {
    id: String(t.id),
    title: String(t.name || ''),
    link, tags, addedBy,
    notes: lines.slice(n).join('\n').trim(),
    createdAt: t.date_created ? new Date(Number(t.date_created)).toISOString() : '',
    clickupUrl: t.url || '',
  };
}

// --- mock store (CLICKUP_MOCK=1) ---
const g = globalThis as any;
function mockStore(): Learning[] {
  return (g.__learnMock ||= [
    { id: 'l1', title: 'Free shipping $60 threshold lifted RPV +4%', link: 'https://example.com/readout-1', tags: ['checkout', 'shipping', 'winner'], notes: 'Kept at $60. AOV up, CVR flat.', addedBy: 'sample@firstday.com', createdAt: '2026-10-02T15:00:00Z', clickupUrl: '' },
    { id: 'l2', title: 'PDP hero: benefit bullets beat lifestyle image', link: 'https://example.com/readout-2', tags: ['pdp', 'creative', 'winner'], notes: '', addedBy: 'sample@firstday.com', createdAt: '2026-10-20T15:00:00Z', clickupUrl: '' },
    { id: 'l3', title: 'Homepage quiz entry point — no impact', link: 'https://example.com/readout-3', tags: ['homepage', 'flat'], notes: 'Not worth the slot.', addedBy: 'sample@firstday.com', createdAt: '2026-11-05T15:00:00Z', clickupUrl: '' },
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
  const l = (res.lists || []).find(x => norm(x.name) === 'test learnings');
  if (!l) throw new Error('No "Test Learnings" list found — create one in the roadmap’s ClickUp space, or set CLICKUP_LEARNINGS_LIST_ID');
  return (listCache = String(l.id));
}

/** Throws unless the task is in the learnings list — the API can't be used to edit roadmap tasks. */
async function assertLearning(id: string): Promise<void> {
  const t = await cu<any>(`/task/${encodeURIComponent(id)}`);
  if (String(t.list?.id) !== (await listId())) throw new Error('Not a learning');
}

export async function getLearnings(): Promise<Learning[]> {
  if (mock()) return [...mockStore()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const id = await listId();
  const out: Learning[] = [];
  for (let page = 0; page < 20; page++) {
    const res = await cu<{ tasks: any[]; last_page?: boolean }>(`/list/${id}/task?page=${page}&include_closed=true&subtasks=false&include_markdown_description=true`);
    out.push(...(res.tasks || []).map(fromTask));
    if (res.last_page || !(res.tasks || []).length) break;
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function addLearning(i: LearningInput, addedBy: string): Promise<Learning> {
  if (mock()) {
    const l: Learning = { id: 'l' + Date.now(), ...i, addedBy, createdAt: new Date().toISOString(), clickupUrl: '' };
    mockStore().push(l);
    return l;
  }
  const t = await cu<any>(`/list/${await listId()}/task`, { method: 'POST', body: { name: i.title, markdown_content: toMarkdown(i, addedBy) } });
  return fromTask({ ...t, markdown_description: toMarkdown(i, addedBy) });
}

export async function updateLearning(id: string, i: LearningInput): Promise<Learning> {
  if (mock()) {
    const s = mockStore(); const k = s.findIndex(x => x.id === id);
    if (k < 0) throw new Error('Not found');
    return (s[k] = { ...s[k], ...i });
  }
  await assertLearning(id);
  const cur = fromTask(await cu<any>(`/task/${encodeURIComponent(id)}?include_markdown_description=true`));
  const md = toMarkdown(i, cur.addedBy);
  const t = await cu<any>(`/task/${encodeURIComponent(id)}`, { method: 'PUT', body: { name: i.title, markdown_content: md } });
  return fromTask({ ...t, markdown_description: md });
}

/** Archives (not deletes) the ClickUp task — it can be restored in ClickUp. */
export async function archiveLearning(id: string): Promise<void> {
  if (mock()) { g.__learnMock = mockStore().filter(x => x.id !== id); return; }
  await assertLearning(id);
  await cu(`/task/${encodeURIComponent(id)}`, { method: 'PUT', body: { archived: true } });
}

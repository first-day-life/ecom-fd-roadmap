// In-memory stand-in for the ClickUp endpoints the app uses, shaped like the
// real "Ecommerce 26-27" folder (4 lists, different statuses and fields per list).
// Enabled with CLICKUP_MOCK=1 so the UI can be developed without a ClickUp token.
// Data resets when the server restarts. Never active unless that env var is set.

const TARGET_MONTH = {
  id: 'f-target-month', name: '📅 Target Month', type: 'drop_down',
  type_config: { options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .map((m, i) => ({ id: `tm-${i}`, name: `${m} 26`, color: '#cbd5e1', orderindex: i })) },
};
const RM_START = { id: 'f-rm-start', name: 'Roadmap Start Date', type: 'date', type_config: {} };
const RM_END = { id: 'f-rm-end', name: 'Roadmap End Date', type: 'date', type_config: {} };

const S = (status: string, color: string, type: string) => ({ status, color, type });

const LISTS: Record<string, { name: string; statuses: any[]; fields: any[] }> = {
  'mock-site': {
    name: 'Site Backlog',
    statuses: [S('backlog', '#ef4444', 'open'), S('prioritized / grooming', '#22c55e', 'custom'), S('in design', '#6366f1', 'custom'), S('in build', '#1090e0', 'custom'), S('qa', '#f8ae00', 'custom'), S('completed', '#008844', 'closed')],
    fields: [RM_START, RM_END],
  },
  'mock-sprint': {
    name: 'Current Sprint',
    statuses: [S('to do', '#87909e', 'open'), S('in-progress', '#2dd4bf', 'custom'), S('qa', '#4466ff', 'custom'), S('ready for deploy', '#87909e', 'custom'), S('complete', '#008844', 'closed')],
    fields: [TARGET_MONTH, RM_START, RM_END],
  },
  'mock-ab': {
    name: 'AB Test Backlog',
    statuses: [S('idea', '#87909e', 'open'), S('test running', '#e50000', 'custom'), S('analyzed', '#2ecd6f', 'closed')],
    fields: [RM_START, RM_END],
  },
  'mock-ideas': {
    name: 'Idea Parking Lot (pre-backlog)',
    statuses: [S('new idea', '#87909e', 'open'), S('promoted', '#008844', 'closed')],
    fields: [TARGET_MONTH, RM_START, RM_END],
  },
};

const MEMBERS = [
  { id: 1, username: 'Alex T.', initials: 'AT', color: '#7b68ee' },
  { id: 2, username: 'Jordan P.', initials: 'JP', color: '#e5484d' },
  { id: 3, username: 'Sam R.', initials: 'SR', color: '#30a46c' },
];

const PRI: Record<number, string> = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };
const ms = (d: string) => String(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 17));

function seed() {
  let n = 0;
  const t = (list: string, name: string, o: { status?: string; pri?: number; month?: number; rstart?: string; rend?: string; start?: string; due?: string; who?: number[]; tags?: string[]; desc?: string } = {}) => {
    n++;
    const L = LISTS[list];
    const cf: any[] = [];
    if (o.month !== undefined) cf.push({ id: TARGET_MONTH.id, value: o.month });   // legacy dropdowns store orderindex
    if (o.rstart) cf.push({ id: RM_START.id, value: ms(o.rstart) });
    if (o.rend) cf.push({ id: RM_END.id, value: ms(o.rend) });
    return {
      id: `mock${n}`, name, url: `https://app.clickup.com/t/mock${n}`, list: { id: list },
      status: L.statuses.find(s => s.status === o.status) || L.statuses[0],
      priority: o.pri ? { priority: PRI[o.pri] } : null,
      assignees: MEMBERS.filter(m => o.who?.includes(m.id)),
      tags: (o.tags || []).map(name => ({ name })),
      start_date: o.start ? ms(o.start) : null,
      due_date: o.due ? ms(o.due) : null,
      markdown_description: o.desc || '',
      custom_fields: cf,
      date_created: String(Date.now() - n * 86400000),
      archived: false,
    };
  };
  return [
    // Site Backlog — mix of native dates, roadmap dates only, and both (native wins)
    t('mock-site', 'Family Bundle Builder v2', { status: 'in build', pri: 2, start: '2026-11-02', due: '2026-11-20', who: [1], desc: 'Let parents build a multi-kid bundle in one flow.' }),
    t('mock-site', 'Post-purchase upsell page', { status: 'prioritized / grooming', pri: 3, rstart: '2026-11-16', rend: '2026-11-25' }),
    t('mock-site', 'All-in-1 bundle launch', { status: 'in design', pri: 2, rstart: '2026-12-01', rend: '2026-12-18', who: [3] }),
    t('mock-site', 'Mobile nav redesign', { status: 'qa', pri: 2, start: '2026-10-19', due: '2026-11-04', rstart: '2026-12-01', rend: '2026-12-10', who: [2], desc: 'Has both task dates and roadmap dates — task dates win.' }),
    t('mock-site', 'Review widget swap', { status: 'backlog', pri: 4 }),
    t('mock-site', 'Black Friday landing page', { status: 'completed', pri: 1, start: '2026-10-05', due: '2026-10-23' }),
    // Current Sprint — native dates + Target Month
    t('mock-sprint', 'Checkout trust badges', { status: 'qa', pri: 3, month: 10, start: '2026-11-09', due: '2026-11-13', who: [2] }),
    t('mock-sprint', 'Fix cart drawer flicker', { status: 'in-progress', pri: 1, month: 10, start: '2026-11-17', due: '2026-11-18', who: [1] }),
    t('mock-sprint', 'Holiday gift-with-purchase', { status: 'complete', pri: 2, month: 10, start: '2026-11-03', due: '2026-11-06', who: [1] }),
    t('mock-sprint', 'Quiz → PDP personalization', { status: 'to do', pri: 2, month: 10, who: [3] }),
    // AB Test Backlog — no custom fields
    t('mock-ab', 'Subscription save-offer test', { status: 'test running', pri: 1, start: '2026-11-16', due: '2026-11-30' }),
    t('mock-ab', 'PDP sticky ATC test', { status: 'idea', pri: 3, rstart: '2026-11-30' }),
    // Idea Parking Lot — Target Month only
    t('mock-ideas', 'Win-back email + LP', { month: 11 }),
    t('mock-ideas', 'Loyalty tiers', { month: 11, pri: 3 }),
    t('mock-ideas', 'Gift guide quiz', { tags: ['roadmap-request'], pri: 3, month: 11, desc: '**Requested by:** Jordan P.\n\nSeasonal quiz that routes to bundles.' }),
  ];
}

const g = globalThis as any;
function store(): any[] { return (g.__cuMock ||= seed()); }

export async function mockFetch(path: string, init: { method?: string; body?: any }): Promise<any> {
  const method = init.method || 'GET';
  const p = new URL('http://x' + path).pathname;
  const tasks = store();
  let m: RegExpMatchArray | null;

  if (method === 'GET' && (m = p.match(/^\/list\/([^/]+)$/))) {
    const L = LISTS[m[1]];
    if (!L) throw new Error('ClickUp 404: List not found');
    return { id: m[1], name: L.name, statuses: L.statuses };
  }
  if (method === 'GET' && (m = p.match(/^\/list\/([^/]+)\/field$/))) return { fields: LISTS[m[1]]?.fields || [] };
  if (method === 'GET' && /\/member$/.test(p)) return { members: MEMBERS };
  if (method === 'GET' && (m = p.match(/^\/list\/([^/]+)\/task$/))) {
    return { tasks: tasks.filter(t => !t.archived && t.list.id === m![1]), last_page: true };
  }

  if (method === 'POST' && (m = p.match(/^\/list\/([^/]+)\/task$/))) {
    const b = init.body;
    const L = LISTS[m[1]];
    const id = `mock${Date.now()}`;
    tasks.push({
      id, name: b.name, url: `https://app.clickup.com/t/${id}`, list: { id: m[1] },
      status: L.statuses.find(s => s.status === b.status) || L.statuses[0],
      priority: b.priority ? { priority: PRI[b.priority] } : null,
      assignees: MEMBERS.filter(x => (b.assignees || []).includes(x.id)),
      tags: (b.tags || []).map((name: string) => ({ name })),
      start_date: b.start_date ? String(b.start_date) : null,
      due_date: b.due_date ? String(b.due_date) : null,
      markdown_description: b.markdown_content || '',
      custom_fields: (b.custom_fields || []).map((c: any) => ({ id: c.id, value: c.value })),
      date_created: String(Date.now()),
      archived: false,
    });
    return { id };
  }

  if ((m = p.match(/^\/task\/([^/]+)$/))) {
    const t = tasks.find(t => t.id === m![1]);
    if (!t) throw new Error('ClickUp 404: Task not found');
    if (method === 'GET') return t;
    if (method === 'PUT') {
      const b = init.body;
      const L = LISTS[t.list.id];
      if ('name' in b) t.name = b.name;
      if ('status' in b) {
        const s = L.statuses.find(s => s.status === b.status);
        if (!s) throw new Error('ClickUp 400: Status does not exist');
        t.status = s;
      }
      if ('priority' in b) t.priority = b.priority ? { priority: PRI[b.priority] } : null;
      if ('markdown_content' in b) t.markdown_description = b.markdown_content;
      if ('start_date' in b) t.start_date = b.start_date ? String(b.start_date) : null;
      if ('due_date' in b) t.due_date = b.due_date ? String(b.due_date) : null;
      if ('archived' in b) t.archived = b.archived;
      if (b.assignees) {
        t.assignees = t.assignees.filter((a: any) => !b.assignees.rem.includes(a.id));
        for (const id of b.assignees.add) if (!t.assignees.some((a: any) => a.id === id)) t.assignees.push(MEMBERS.find(x => x.id === id));
      }
      return t;
    }
  }

  if ((m = p.match(/^\/task\/([^/]+)\/field\/([^/]+)$/))) {
    const t = tasks.find(t => t.id === m![1]);
    if (!t) throw new Error('ClickUp 404: Task not found');
    t.custom_fields = t.custom_fields.filter((c: any) => c.id !== m![2]);
    if (method === 'POST') t.custom_fields.push({ id: m[2], value: init.body.value });
    return {};
  }

  if ((m = p.match(/^\/task\/([^/]+)\/tag\/([^/]+)$/)) && method === 'DELETE') {
    const t = tasks.find(t => t.id === m![1]);
    const tag = decodeURIComponent(m[2]);
    t.tags = t.tags.filter((x: any) => x.name !== tag);
    return {};
  }

  throw new Error(`Mock ClickUp: unhandled ${method} ${path}`);
}

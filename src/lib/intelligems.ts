// Read-only access to Intelligems A/B tests via the Intelligems External API (beta).
// Docs: https://docs.intelligems.io/developer-resources/external-api
//   GET https://api.intelligems.io/v25-10-beta/experiences-list?status=started&category=experiment
//   Header: intelligems-access-token: <INTELLIGEMS_API_KEY>
// Only GET requests are made — this app never changes anything in Intelligems.

export interface LiveTest {
  id: string;
  name: string;
  status: 'started' | 'paused';
  type: string;              // e.g. content/url, content/advanced, pricing
  typeLabel: string;
  startedAt: string;         // ISO
  pausedAt: string;          // ISO or ''
  daysRunning: number;       // whole days since start (until pause, if paused)
  variations: Array<{ name: string; percentage: number; isControl: boolean }>;
  estimatedDays: { low: number | null; high: number | null } | null;
  previewPath: string;
}

const API = 'https://api.intelligems.io/v25-10-beta';
const TTL = 5 * 60 * 1000;   // the list endpoint allows ~50 requests / 30s; cache keeps us far below that
let cache: { at: number; tests: LiveTest[] } | null = null;

const TYPE_LABELS: Record<string, string> = {
  'content/url': 'Split URL',
  'content/advanced': 'Advanced content',
  'content/onsiteEdits': 'Onsite edits',
  'content/theme': 'Theme',
  'content/template': 'Template',
  pricing: 'Pricing',
  shipping: 'Shipping',
  checkoutBlock: 'Checkout block',
  postPurchase: 'Post-purchase',
  onsiteUpsell: 'Onsite upsell',
  sitewide: 'Sitewide offer',
};

/** Timestamps come back as ms epoch numbers (REST docs) — accept ISO strings too. */
function toIso(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

function mapTest(e: any): LiveTest | null {
  const startedAt = toIso(e.startedAtTs);
  if (!startedAt) return null;
  const pausedAt = e.status === 'paused' ? toIso(e.pausedAtTs) : '';
  const until = pausedAt ? new Date(pausedAt).getTime() : Date.now();
  const est = e.experienceAnalysis?.estimatedTestLengthRange;
  return {
    id: String(e.id),
    name: String(e.name || 'Untitled test'),
    status: e.status === 'paused' ? 'paused' : 'started',
    type: String(e.type || ''),
    typeLabel: TYPE_LABELS[e.type] || String(e.type || 'Test'),
    startedAt,
    pausedAt,
    daysRunning: Math.max(0, Math.floor((until - new Date(startedAt).getTime()) / 86400000)),
    variations: (e.variations || [])
      .slice()
      .sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0))
      .map((v: any) => ({ name: String(v.name || ''), percentage: Number(v.percentage) || 0, isControl: !!v.isControl })),
    estimatedDays: est && (est.low != null || est.high != null) ? { low: est.low ?? null, high: est.high ?? null } : null,
    previewPath: String(e.previewPath || ''),
  };
}

async function fetchStatus(key: string, status: 'started' | 'paused'): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${API}/experiences-list?status=${status}&category=experiment&limit=50&page=${page}`, {
      headers: { 'intelligems-access-token': key },
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Intelligems ${res.status}: ${body.slice(0, 200) || res.statusText}`);
    }
    const data = await res.json();
    out.push(...(data.experiencesList || []));
    if (!data.totalPages || page >= data.totalPages) break;
  }
  return out;
}

function mockTests(): LiveTest[] {
  const ago = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
  const t = (id: string, name: string, type: string, days: number, est: [number, number] | null, status: 'started' | 'paused' = 'started'): LiveTest => ({
    id, name, status, type, typeLabel: TYPE_LABELS[type] || type, startedAt: ago(days), pausedAt: status === 'paused' ? ago(2) : '',
    daysRunning: status === 'paused' ? days - 2 : days,
    variations: [{ name: 'Control', percentage: 50, isControl: true }, { name: 'Variant B', percentage: 50, isControl: false }],
    estimatedDays: est ? { low: est[0], high: est[1] } : null, previewPath: '/',
  });
  return [
    t('m1', '[Broad-PDP] 90 Option V2', 'content/url', 22, [14, 28]),
    t('m2', '[Homepage] BF hero: whole family + mystery gift $75', 'content/advanced', 11, null),
    t('m3', '[TDK-BTS] 90 option v3', 'content/url', 1, [21, 35]),
    t('m4', '[Checkout] Free shipping threshold $60', 'shipping', 40, [21, 30], 'paused'),
  ];
}

export function intelligemsConfigured(): boolean {
  return !!process.env.INTELLIGEMS_API_KEY || process.env.CLICKUP_MOCK === '1';
}

export async function getLiveTests(): Promise<LiveTest[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.tests;
  const key = process.env.INTELLIGEMS_API_KEY || '';
  let tests: LiveTest[];
  if (!key) {
    if (process.env.CLICKUP_MOCK === '1') tests = mockTests();
    else throw new Error('INTELLIGEMS_API_KEY is not set');
  } else {
    const [live, paused] = await Promise.all([fetchStatus(key, 'started'), fetchStatus(key, 'paused')]);
    tests = [...live, ...paused].map(mapTest).filter((x): x is LiveTest => !!x);
  }
  tests.sort((a, b) => (a.status === b.status ? b.daysRunning - a.daysRunning : a.status === 'started' ? -1 : 1));
  cache = { at: Date.now(), tests };
  return tests;
}

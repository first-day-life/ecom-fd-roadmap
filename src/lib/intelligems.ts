// Read-only access to Intelligems A/B tests via the Intelligems External API (beta).
// Docs: https://docs.intelligems.io/developer-resources/external-api
//   GET https://api.intelligems.io/v25-10-beta/experiences-list?status=started&category=experiment
//   Header: intelligems-access-token: <INTELLIGEMS_API_KEY>
// Only GET requests are made — this app never changes anything in Intelligems.

export type MetricKey = 'rpv' | 'aov' | 'cvr';
export const METRIC_LABEL: Record<MetricKey, string> = { rpv: 'RPV', aov: 'AOV', cvr: 'CVR' };
const METRIC_FIELD: Record<MetricKey, string> = { rpv: 'net_revenue_per_visitor', aov: 'net_revenue_per_order', cvr: 'conversion_rate' };

export const MIN_ORDERS = 300;   // per variant
export const SIG = 0.95;         // chance to beat control (or ≤ 5% for a significant loss)

export interface MetricResult {
  value: number | null;          // variant's metric value
  uplift: number | null;         // vs control, e.g. 0.04 = +4%
  p2bc: number | null;           // chance to beat control, 0–1
  sig: 'win' | 'lose' | null;    // reached 95% either way
  daysToSig: number | null;      // estimated extra days to 95% if the current effect holds (null = n/a)
}

export interface VariantResult {
  name: string;
  isControl: boolean;
  orders: number;
  ordersPerDay: number;
  daysTo300: number | null;      // null when already ≥ 300 or no orders yet
  metrics: Partial<Record<MetricKey, MetricResult>>;
}

export interface TestResults {
  call: 'winner' | 'loser' | 'mixed' | 'not_ready' | 'no_data';
  headline: string;
  reasons: string[];
  variants: VariantResult[];
  etaDays: number | null;        // estimated days until a call could be made (max of orders/sig needs)
  igVerdict: string | null;      // Intelligems' own verdict (e.g. not_ready, strong_win)
  estMonthlyImpact: number | null;
  error?: string;
}

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
  url: string;                   // link to open the test in Intelligems
  targets: string[];             // pages/areas the test touches: paths ("/products/x"), "~text" (URL contains), or "sitewide"
  results: TestResults | null;
}

const SITEWIDE_TYPES = new Set(['pricing', 'shipping', 'sitewide', 'onsiteUpsell', 'checkoutBlock', 'postPurchase']);

/** Where a test runs, from its redirects (split-URL tests) and page-targeting rules. */
function targetsFor(e: any): string[] {
  const out = new Set<string>();
  const add = (filter: string | null | undefined, value: string | null | undefined) => {
    const v = String(value || '').trim();
    if (!v) return;
    const isUrlish = v.startsWith('/') || /^https?:\/\//i.test(v);
    if (filter === 'contains' || !isUrlish) out.add('~' + v.toLowerCase());
    else out.add(v.replace(/^https?:\/\/[^/]+/i, '').replace(/[?#].*$/, '').replace(/(.)\/$/, '$1').toLowerCase() || '/');
  };
  for (const v of e.variations || []) for (const r of v.redirects || []) add(r.filter, r.originUrl);
  for (const rule of e.experiencePageTargeting || []) {
    for (const ex of rule.expression || []) {
      const q = ex?.query;
      if (q && (q.type === 'urlPath' || q.type === 'url')) add(q.filter === 'contains' ? 'contains' : 'path', q.value);
    }
    if (rule.value) add(rule.filterType === 'contains' ? 'contains' : 'path', rule.value);
  }
  if (!out.size && SITEWIDE_TYPES.has(e.type)) out.add('sitewide');
  return Array.from(out);
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

/** Link to the test in Intelligems. INTELLIGEMS_TEST_URL can contain {id}; default opens Intelligems in Shopify admin. */
function testUrl(id: string): string {
  const tpl = process.env.INTELLIGEMS_TEST_URL || `https://admin.shopify.com/store/${process.env.SHOPIFY_STORE_HANDLE || 'first-day-inc'}/apps/intelligems`;
  return tpl.replace('{id}', encodeURIComponent(id));
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

/**
 * Apply the call rules to Intelligems' per-variation stats:
 *  - a variant needs ≥ 300 orders, and
 *  - at least one of RPV / AOV / CVR must be ≥ 95% likely to beat control (win) or ≤ 5% (loss).
 * When not ready: days to 300 orders from the current pace, and days to 95% by scaling the
 * uplift's 95% interval with 1/√time (assumes the observed effect holds).
 */
export function evaluate(raw: any, runtimeDays: number): TestResults {
  const days = Math.max(1, runtimeDays);
  const rows: any[] = raw?.metrics || [];
  const vars: any[] = (raw?.variations || []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
  const variants: VariantResult[] = vars.map(v => {
    const row = rows.find(r => r.variation_id === v.id) || {};
    const orders = Number(row.n_orders?.value) || 0;
    const perDay = orders / days;
    const metrics: Partial<Record<MetricKey, MetricResult>> = {};
    for (const k of Object.keys(METRIC_FIELD) as MetricKey[]) {
      const m = row[METRIC_FIELD[k]];
      if (!m) continue;
      const p2bc = typeof m.p2bc === 'number' ? m.p2bc : null;
      const up = m.uplift?.value ?? null;
      const half = m.uplift?.plus_minus ?? null;
      const sig = p2bc == null ? null : p2bc >= SIG ? 'win' : p2bc <= 1 - SIG ? 'lose' : null;
      let daysToSig: number | null = null;
      if (!sig && days >= 7 && up && half && Math.abs(up) > 1e-6) {
        const factor = (half / Math.abs(up)) ** 2;          // time multiplier until |uplift| clears the 95% half-width
        daysToSig = Math.max(1, Math.ceil(days * (factor - 1)));
      }
      metrics[k] = { value: m.value ?? null, uplift: up, p2bc, sig, daysToSig };
    }
    return {
      name: String(v.name || ''),
      isControl: !!v.isControl,
      orders,
      ordersPerDay: Math.round(perDay * 10) / 10,
      daysTo300: orders >= MIN_ORDERS ? null : perDay > 0 ? Math.ceil((MIN_ORDERS - orders) / perDay) : null,
      metrics,
    };
  });

  const igVerdict = raw?.testResult?.verdict ?? null;
  const estMonthlyImpact = typeof raw?.impact?.est_monthly_revenue_increase === 'number' ? raw.impact.est_monthly_revenue_increase : null;
  const challengers = variants.filter(v => !v.isControl);
  if (!challengers.length || variants.every(v => v.orders === 0)) {
    return { call: 'no_data', headline: 'No results yet', reasons: ['No orders recorded yet.'], variants, etaDays: null, igVerdict, estMonthlyImpact };
  }

  // Evaluate each challenger; report the most decisive one
  const evals = challengers.map(v => {
    const sigs = (Object.keys(v.metrics) as MetricKey[]).filter(k => v.metrics[k]!.sig);
    const wins = sigs.filter(k => v.metrics[k]!.sig === 'win');
    const losses = sigs.filter(k => v.metrics[k]!.sig === 'lose');
    const enough = v.orders >= MIN_ORDERS;
    const fastest = (Object.keys(v.metrics) as MetricKey[])
      .map(k => ({ k, d: v.metrics[k]!.daysToSig }))
      .filter(x => x.d != null)
      .sort((a, b) => a.d! - b.d!)[0];
    return { v, wins, losses, enough, fastest };
  });

  const describe = (v: VariantResult, keys: MetricKey[]) => keys.map(k => `${METRIC_LABEL[k]} ${v.metrics[k]!.uplift != null ? pct(v.metrics[k]!.uplift!) : ''}`.trim()).join(', ');
  const callable = evals.filter(e => e.enough && (e.wins.length || e.losses.length));

  if (callable.length) {
    const e = callable.sort((a, b) => (b.wins.length + b.losses.length) - (a.wins.length + a.losses.length))[0];
    const rpv = e.v.metrics.rpv;
    const reasons = [
      `${e.v.name}: ${e.v.orders.toLocaleString()} orders (≥ ${MIN_ORDERS}).`,
      ...(e.wins.length ? [`95%+ likely better on ${describe(e.v, e.wins)}.`] : []),
      ...(e.losses.length ? [`95%+ likely worse on ${describe(e.v, e.losses)}.`] : []),
    ];
    if (e.wins.length && e.losses.length) {
      reasons.push(rpv?.sig ? `RPV decides it: ${rpv.sig === 'win' ? 'variant better' : 'control better'}.` : `RPV isn't significant (${rpv?.uplift != null ? pct(rpv.uplift) : 'n/a'}), so it's a trade-off.`);
      return { call: 'mixed', headline: `⚖️ Callable — mixed: ${e.v.name} wins ${e.wins.map(k => METRIC_LABEL[k]).join('/')}, loses ${e.losses.map(k => METRIC_LABEL[k]).join('/')}`, reasons, variants, etaDays: 0, igVerdict, estMonthlyImpact };
    }
    if (e.wins.length) return { call: 'winner', headline: `🏆 Winner: ${e.v.name} (${describe(e.v, e.wins)})`, reasons, variants, etaDays: 0, igVerdict, estMonthlyImpact };
    return { call: 'loser', headline: `🛑 Control wins — ${e.v.name} is worse (${describe(e.v, e.losses)})`, reasons, variants, etaDays: 0, igVerdict, estMonthlyImpact };
  }

  // Not ready: say what's missing and roughly how long
  const reasons: string[] = [];
  let eta: number | null = 0;
  for (const e of evals) {
    const parts: string[] = [];
    if (!e.enough) {
      parts.push(e.v.daysTo300 != null ? `${e.v.orders} / ${MIN_ORDERS} orders — ~${e.v.daysTo300} more day${e.v.daysTo300 === 1 ? '' : 's'} at ${e.v.ordersPerDay}/day` : `${e.v.orders} / ${MIN_ORDERS} orders`);
      eta = eta == null || e.v.daysTo300 == null ? null : Math.max(eta, e.v.daysTo300);
    }
    if (!e.wins.length && !e.losses.length) {
      if (days < 7) {
        parts.push('too early to estimate time to 95% (under 7 days of data)');
      } else if (e.fastest && e.fastest.d! <= 180) {
        parts.push(`no metric at 95% yet — ${METRIC_LABEL[e.fastest.k]} (${pct(e.v.metrics[e.fastest.k]!.uplift!)}) could get there in ~${e.fastest.d} days if the trend holds`);
        eta = eta == null ? null : Math.max(eta, e.fastest.d!);
      } else {
        parts.push('no metric at 95%, and current differences are too small to reach it in a reasonable time (likely no real difference)');
        eta = null;
      }
    } else if (!e.enough) {
      parts.push(`already 95% on ${describe(e.v, [...e.wins, ...e.losses])} — just needs the order count`);
    }
    reasons.push(`${e.v.name}: ${parts.join('; ')}.`);
  }
  return { call: 'not_ready', headline: eta ? `⏳ Not ready — about ${eta} more day${eta === 1 ? '' : 's'}` : '⏳ Not ready', reasons, variants, etaDays: eta, igVerdict, estMonthlyImpact };
}

async function fetchResults(key: string, id: string, runtimeDays: number): Promise<TestResults> {
  try {
    const res = await fetch(`${API}/analytics/resource/${id}`, {
      method: 'POST',                                   // read-only analytics query (POST carries the query body)
      headers: { 'intelligems-access-token': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: 'overview', testResult: true }),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Intelligems ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    return evaluate(await res.json(), runtimeDays);
  } catch (e: any) {
    return { call: 'no_data', headline: 'Results unavailable', reasons: [], variants: [], etaDays: null, igVerdict: null, estMonthlyImpact: null, error: e?.message || String(e) };
  }
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
    url: testUrl(String(e.id)),
    targets: targetsFor(e),
    results: null,
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
    estimatedDays: est ? { low: est[0], high: est[1] } : null, previewPath: '/', url: testUrl(id), targets: [], results: null,
  });
  const raw = (ordersC: number, ordersV: number, m: Record<string, [number, number, number]>, impact = -24373) => ({
    variations: [{ id: 'c', name: 'Control Group', isControl: true, order: 0 }, { id: 'v', name: 'New Group 1', isControl: false, order: 1 }],
    metrics: [
      { variation_id: 'c', n_orders: { value: ordersC } },
      { variation_id: 'v', n_orders: { value: ordersV }, ...Object.fromEntries(Object.entries(m).map(([f, [up, p2bc, pm]]) => [f, { value: 1, p2bc, uplift: { value: up, plus_minus: pm } }])) },
    ],
    testResult: { verdict: 'not_ready' },
    impact: { est_monthly_revenue_increase: impact },
  });
  const tests = [
    t('m1', '[Broad-PDP] 90 Option V2', 'content/url', 22, [14, 28]),
    t('m2', '[Homepage] BF hero: whole family + mystery gift $75', 'content/advanced', 11, null),
    t('m3', '[TDK-BTS] 90 option v3', 'content/url', 1, [21, 35]),
    t('m5', '[TDK-BTS] vs Preorder LP', 'content/url', 1, null),
    t('m4', '[Checkout] Free shipping threshold $60', 'shipping', 40, [21, 30], 'paused'),
  ];
  tests[0].targets = ['/products/kids-calming-magnesium', '/products/kids-daily-focus', '~starter-pack'];
  tests[1].targets = ['/'];
  tests[2].targets = ['/pages/tdk-behind-the-science-lp'];
  tests[3].targets = ['/pages/tdk-behind-the-science-lp'];
  tests[4].targets = ['sitewide'];
  // Real numbers from [Broad-PDP] 90 Option V2 for the first; synthetic for the rest
  tests[0].results = evaluate(raw(4208, 3883, { net_revenue_per_visitor: [-0.034, 0.133, 0.058], net_revenue_per_order: [0.041, 0.966, 0.046], conversion_rate: [-0.073, 0.0002, 0.039] }), 22);
  tests[1].results = evaluate(raw(260, 228, { net_revenue_per_visitor: [0.06, 0.83, 0.09], net_revenue_per_order: [0.01, 0.6, 0.05], conversion_rate: [0.05, 0.86, 0.08] }, 6100), 11);
  tests[2].results = evaluate(raw(14, 11, { net_revenue_per_visitor: [0.01, 0.52, 0.4], net_revenue_per_order: [0.0, 0.5, 0.3], conversion_rate: [0.005, 0.51, 0.35] }, 400), 1);
  tests[3].results = evaluate(raw(12, 9, { net_revenue_per_visitor: [0.0, 0.5, 0.5] }, 0), 1);
  tests[4].results = evaluate(raw(910, 902, { net_revenue_per_visitor: [0.08, 0.98, 0.06], net_revenue_per_order: [0.05, 0.97, 0.04], conversion_rate: [0.02, 0.8, 0.04] }, 12800), 38);
  return tests;
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
    // Per-test results (one analytics call each, cached with the list for 5 min)
    await Promise.all(tests.map(async t => { t.results = await fetchResults(key, t.id, t.daysRunning); }));
  }
  tests.sort((a, b) => (a.status === b.status ? b.daysRunning - a.daysRunning : a.status === 'started' ? -1 : 1));
  cache = { at: Date.now(), tests };
  return tests;
}

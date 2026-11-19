// Ended-test sync: when an Intelligems test ends, write its final results into the
// Test Learnings list in ClickUp.
//
//  - Looks at tests that ended in the last LOOKBACK_DAYS days (read-only Intelligems calls).
//  - Finds the learning for each test by its Intelligems link (or, failing that, a title that
//    contains the test name). Archived learnings count too, so an entry someone archived is
//    never re-created.
//  - No learning yet → creates one with dates, quarter, outcome, page/product guesses, the
//    Intelligems link and a "Final results" block. Hypothesis / learning / next steps are left
//    for a person to write.
//  - Learning exists → fills only EMPTY fields, and adds the "Final results" block to Result
//    (below anything already written). Nothing a person wrote is overwritten.
//  - A learning whose Result already has the block is skipped, so running it again changes nothing.
// Only the Test Learnings list is written. Roadmap tasks and their dates are never touched.

import { evaluate, fetchResults, getEndedTests, intelligemsKey, METRIC_LABEL, type EndedTest, type MetricKey, type TestResults } from './intelligems';
import { addLearning, getLearnings, updateLearning, type Learning, type LearningFields, type LearningOptions } from './learnings';

export const LOOKBACK_DAYS = 14;
export const RESULTS_MARK = '**Final results · Intelligems**';
const BY = 'Intelligems sync (automatic)';

export interface SyncAction {
  test: string;
  testId: string;
  ended: string;                       // YYYY-MM-DD
  action: 'create' | 'update' | 'skip';
  reason: string;
  learningId?: string;
  learningTitle?: string;
  fields?: string[];                   // fields written
  values?: Record<string, unknown>;    // dry run only: what would be written
}

const tz = () => process.env.ROADMAP_TIMEZONE || 'America/New_York';
function ymd(iso: string): { y: number; m: number; d: number } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz(), year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(iso));
  const get = (t: string) => Number(p.find(x => x.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}
const iso10 = (iso: string) => { const a = ymd(iso); return `${a.y}-${String(a.m).padStart(2, '0')}-${String(a.d).padStart(2, '0')}`; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "11/10 – 11/16/2026" (same style as the migrated learnings). */
function datesText(t: EndedTest): string {
  const a = ymd(t.startedAt), b = ymd(t.endedAt);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${b.m}/${b.d}/${b.y}`;
  return `${a.m}/${a.d}${a.y !== b.y ? '/' + a.y : ''} – ${b.m}/${b.d}/${b.y}`;
}
const quarterOf = (t: EndedTest) => { const b = ymd(t.endedAt); return `${b.y}-q${Math.ceil(b.m / 3)}`; };

const pct = (x: number) => `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(1)}%`;
const OUTCOME: Record<TestResults['call'], string> = { winner: 'winner', loser: 'loser', mixed: 'mixed', not_ready: 'inconclusive', no_data: 'inconclusive' };

/** The markdown block written into the Result field. */
export function resultsBlock(t: EndedTest, r: TestResults): string {
  const b = ymd(t.endedAt);
  const headline = r.call === 'not_ready' ? 'No metric reached 95% before the test ended' : r.headline;
  const lines = [`${RESULTS_MARK} (ended ${MON[b.m - 1]} ${b.d}, ${b.y} · ran ${t.days} day${t.days === 1 ? '' : 's'})`, headline];
  const control = r.variants.find(v => v.isControl);
  for (const v of r.variants.filter(v => !v.isControl)) {
    if (r.variants.length > 2) lines.push(`**${v.name}**`);
    for (const k of ['rpv', 'aov', 'cvr'] as MetricKey[]) {
      const m = v.metrics[k];
      if (!m || m.uplift == null) continue;
      const conf = m.p2bc == null ? '' : m.p2bc >= 0.5 ? ` · ${Math.round(m.p2bc * 100)}% likely better` : ` · ${Math.round((1 - m.p2bc) * 100)}% likely worse`;
      lines.push(`- **${METRIC_LABEL[k]}** ${pct(m.uplift)}${conf}${m.sig ? ' (significant)' : ''}`);
    }
  }
  const orders = r.variants.map(v => `${v.name} ${v.orders.toLocaleString('en-US')}`).join(' · ');
  if (orders) lines.push(`- Orders: ${orders}`);
  if (r.estMonthlyImpact != null && Math.abs(r.estMonthlyImpact) >= 1) {
    lines.push(`- Intelligems est. monthly impact: ${r.estMonthlyImpact >= 0 ? '+' : '-'}$${Math.round(Math.abs(r.estMonthlyImpact)).toLocaleString('en-US')}`);
  }
  if (!control && r.variants.length) lines.push('- (No control group found)');
  return lines.join('\n');
}

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function findLearning(t: EndedTest, all: Learning[]): Learning | undefined {
  const byId = all.find(l => [l.intelligems, l.intelligemsResults, l.link, l.notes].some(v => v && v.includes(t.id)));
  if (byId) return byId;
  const n = normName(t.name);
  return n.length >= 8 ? all.find(l => normName(l.title).includes(n)) : undefined;
}

/** Best-effort page type / product from the test name and targets, limited to the list's options. */
function guess(t: EndedTest, options: LearningOptions): Pick<LearningFields, 'pageType' | 'product'> {
  const s = (t.name + ' ' + t.targets.join(' ')).toLowerCase();
  const pageType: string[] = [];
  const add = (v: string, hit: boolean) => { if (hit && options.pageType.includes(v) && !pageType.includes(v)) pageType.push(v); };
  add('homepage', /\[(homepage|hp)\]|homepage|(^|\s)\/(\s|$)/.test(s));
  add('sale-page', s.includes('/pages/sale'));
  add('pdp', /pdp|\/products\//.test(s));
  add('lp', /bts|\blp\b|behind-the-science|landing/.test(s));
  add('checkout', s.includes('checkout'));
  add('cart', /\bcart\b/.test(s));
  add('navigation', /\bnav(igation)?\b|subnav/.test(s));
  add('search', /\bsearch\b/.test(s));
  const product = options.product.filter(p => new RegExp(`(^|[^a-z])${p}([^a-z]|$)`).test(s));
  return { pageType, product };
}

const isEmpty = (v: unknown) => (Array.isArray(v) ? v.length === 0 : !String(v ?? '').trim());

export async function syncEndedTests(opts: { dryRun?: boolean; days?: number } = {}): Promise<{ checked: number; actions: SyncAction[] }> {
  const days = opts.days ?? LOOKBACK_DAYS;
  const key = intelligemsKey();
  const [ended, active, archived] = await Promise.all([getEndedTests(days), getLearnings(), getLearnings({ archived: true })]);
  const all = [...active.learnings, ...archived.learnings];
  const archivedIds = new Set(archived.learnings.map(l => l.id));
  const options = active.options;
  const actions: SyncAction[] = [];

  for (const t of ended) {
    const base = { test: t.name, testId: t.id, ended: iso10(t.endedAt) };
    const l = findLearning(t, all);
    if (l && archivedIds.has(l.id)) { actions.push({ ...base, action: 'skip', reason: 'Its learning is archived', learningId: l.id, learningTitle: l.title }); continue; }
    if (l && l.result.includes(RESULTS_MARK)) { actions.push({ ...base, action: 'skip', reason: 'Final results already written', learningId: l.id, learningTitle: l.title }); continue; }

    const r = key ? await fetchResults(key, t.id, t.days) : evaluate(null, t.days);
    if (r.error) { actions.push({ ...base, action: 'skip', reason: `Couldn't read results: ${r.error}` }); continue; }
    const totalOrders = r.variants.reduce((n, v) => n + v.orders, 0);
    if (!l && totalOrders < 20) { actions.push({ ...base, action: 'skip', reason: `Only ${totalOrders} orders (looks like a setup/QA test)` }); continue; }

    const block = resultsBlock(t, r);
    const sigMetrics = r.variants.filter(v => !v.isControl)
      .flatMap(v => (Object.keys(v.metrics) as MetricKey[]).filter(k => v.metrics[k]!.sig).map(k => METRIC_LABEL[k]))
      .filter((x, i, a) => a.indexOf(x) === i && options.metric.includes(x));
    const g = guess(t, options);
    const proposed: Partial<LearningFields> = {
      dates: datesText(t),
      quarter: options.quarter.includes(quarterOf(t)) ? quarterOf(t) : '',
      outcome: options.outcome.includes(OUTCOME[r.call]) ? OUTCOME[r.call] : '',
      metric: sigMetrics,
      pageType: g.pageType,
      product: g.product,
    };

    if (!l) {
      const input = {
        title: t.name.slice(0, 200),
        ...Object.fromEntries(Object.entries(proposed).filter(([, v]) => !isEmpty(v))),
        intelligems: t.resultsUrl,
        result: block,
        notes: 'Added automatically when the test ended in Intelligems. Still to write: hypothesis, learning, next steps and rollout.',
      };
      const fields = Object.keys(input).filter(k => k !== 'title' && k !== 'notes');
      if (opts.dryRun) { actions.push({ ...base, action: 'create', reason: 'No learning yet', fields, values: input }); continue; }
      const made = await addLearning(input, BY);
      actions.push({ ...base, action: 'create', reason: 'No learning yet', learningId: made.id, learningTitle: made.title, fields });
      continue;
    }

    // Existing learning: fill only empty fields, add the results block below any existing Result text
    const changes: Partial<LearningFields> = {};
    for (const [k, v] of Object.entries(proposed)) if (!isEmpty(v) && isEmpty((l as any)[k])) (changes as any)[k] = v;
    if (!l.intelligems && !l.intelligemsResults) changes.intelligems = t.resultsUrl;
    changes.result = l.result.trim() ? `${l.result.trim()}\n\n${block}` : block;
    const fields = Object.keys(changes);
    if (!opts.dryRun) await updateLearning(l.id, { title: l.title, ...changes });
    actions.push({ ...base, action: 'update', reason: 'Learning found; filled empty fields', learningId: l.id, learningTitle: l.title, fields, ...(opts.dryRun ? { values: changes } : {}) });
  }
  return { checked: ended.length, actions };
}

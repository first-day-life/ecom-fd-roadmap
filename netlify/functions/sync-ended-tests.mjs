// Netlify scheduled function: every hour, ask the app to write final results of Intelligems
// tests that just ended into the Test Learnings list in ClickUp (see src/lib/igSync.ts).
// Runs only on the published production deploy.
import { createHash } from 'node:crypto';

export default async () => {
  const site = process.env.URL;
  const token = (process.env.CLICKUP_API_TOKEN || '').trim();
  if (!site || !token) { console.log('sync-ended-tests: URL or CLICKUP_API_TOKEN missing'); return; }
  const key = createHash('sha256').update('roadmap-sync:' + token).digest('hex');
  const res = await fetch(`${site}/api/sync/intelligems`, { method: 'POST', headers: { 'x-sync-key': key } });
  const body = await res.text();
  console.log(`sync-ended-tests: ${res.status} ${body.slice(0, 2000)}`);
};

export const config = { schedule: '@hourly' };

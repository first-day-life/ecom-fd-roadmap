import { NextRequest, NextResponse } from 'next/server';
import { syncEndedTests } from '@/lib/igSync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET  ?dry=1 — preview what the sync would do (writes nothing)
// POST        — run it: write final results of recently ended Intelligems tests into Test Learnings.
// Called hourly by netlify/functions/sync-ended-tests.mjs, or from the Learnings page.
async function run(req: NextRequest, dryRun: boolean) {
  const days = Math.min(60, Math.max(1, Number(req.nextUrl.searchParams.get('days')) || 14));
  try {
    const out = await syncEndedTests({ dryRun, days });
    return NextResponse.json({ dryRun, days, ...out, at: new Date().toISOString() });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return run(req, true); }
export async function POST(req: NextRequest) { return run(req, req.nextUrl.searchParams.get('dry') === '1'); }

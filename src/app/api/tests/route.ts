import { NextResponse } from 'next/server';
import { getLiveTests, intelligemsConfigured } from '@/lib/intelligems';

export const dynamic = 'force-dynamic';

// GET — live and paused Intelligems A/B tests (read-only)
export async function GET() {
  if (!intelligemsConfigured()) {
    return NextResponse.json({ configured: false, tests: [] });
  }
  try {
    return NextResponse.json({ configured: true, tests: await getLiveTests() });
  } catch (err: any) {
    return NextResponse.json({ configured: true, tests: [], error: err.message }, { status: 502 });
  }
}

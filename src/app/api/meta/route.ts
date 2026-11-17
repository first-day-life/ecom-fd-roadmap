import { NextResponse } from 'next/server';
import { getMeta } from '@/lib/clickup';

export const dynamic = 'force-dynamic';

// Public metadata for the request form: pillar choices and the month options of the
// list that requests are filed into.
export async function GET() {
  try {
    const meta = await getMeta();
    const reqList = meta.lists.find(l => l.id === meta.requestListId);
    return NextResponse.json({
      pillars: reqList?.fields.pillar ? reqList.pillars : [],
      monthOptions: reqList?.fields.roadmapMonth ? reqList.monthOptions : [],
      mock: meta.mock,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

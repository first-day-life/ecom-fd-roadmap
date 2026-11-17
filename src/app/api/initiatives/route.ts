import { NextRequest, NextResponse } from 'next/server';
import { getInitiatives, getMeta, addInitiative } from '@/lib/clickup';

export const dynamic = 'force-dynamic';

// GET — roadmap items plus the list metadata (statuses, pillars, members…) in one round trip
export async function GET() {
  try {
    const [items, meta] = await Promise.all([getInitiatives(), getMeta()]);
    return NextResponse.json({ items, meta });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name?.trim()) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    }
    const item = await addInitiative({ ...body, name: body.name.trim() });
    return NextResponse.json(item, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

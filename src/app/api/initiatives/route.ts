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
    if (['startDate', 'dueDate', 'start_date', 'due_date'].some(k => k in body)) {
      return NextResponse.json({ error: 'The roadmap never sets ClickUp start/due dates. Set Roadmap Start/End Date instead.' }, { status: 400 });
    }
    const { name, listId, status, priority, pillar, bigSwing, roadmapMonth, roadmapStart, roadmapEnd, sprint, testTargeting, ownerId, notes } = body;
    const item = await addInitiative({ name: name.trim(), listId, status, priority, pillar, bigSwing, roadmapMonth, roadmapStart, roadmapEnd, sprint, testTargeting, ownerId, notes });
    return NextResponse.json(item, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

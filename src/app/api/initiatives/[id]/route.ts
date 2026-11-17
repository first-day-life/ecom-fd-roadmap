import { NextRequest, NextResponse } from 'next/server';
import { updateInitiative, archiveInitiative } from '@/lib/clickup';
import type { InitiativeInput } from '@/lib/types';

export const dynamic = 'force-dynamic';

const ALLOWED: (keyof InitiativeInput)[] = ['name', 'status', 'priority', 'pillar', 'bigSwing', 'roadmapMonth', 'roadmapStart', 'roadmapEnd', 'sprint', 'testTargeting', 'ownerId', 'notes'];
// ClickUp's native task dates are read-only for this app.
const FORBIDDEN = ['startDate', 'dueDate', 'start_date', 'due_date'];

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const forbidden = FORBIDDEN.filter(k => k in body);
    if (forbidden.length) {
      return NextResponse.json({ error: 'The roadmap never changes ClickUp start/due dates. Set Roadmap Start/End Date instead.' }, { status: 400 });
    }
    const input: InitiativeInput = {};
    for (const k of ALLOWED) if (k in body) (input as any)[k] = body[k];
    const updated = await updateInitiative(params.id, input);
    return NextResponse.json(updated);
  } catch (err: any) {
    const status = /404/.test(err.message) ? 404 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}

// DELETE — archives the ClickUp task (reversible from ClickUp), never hard-deletes
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await archiveInitiative(params.id);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    const status = /404/.test(err.message) ? 404 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}

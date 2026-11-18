import { NextRequest, NextResponse } from 'next/server';
import { updateLearning, archiveLearning, inputFromBody, badUrl } from '@/lib/learnings';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  try {
    const input = inputFromBody(await req.json());
    if (!input.title) return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    const bad = badUrl(input);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
    return NextResponse.json(await updateLearning(params.id, input));
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.message === 'Not a learning' ? 403 : 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  try {
    await archiveLearning(params.id);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: err.message === 'Not a learning' ? 403 : 500 });
  }
}

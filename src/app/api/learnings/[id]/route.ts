import { NextRequest, NextResponse } from 'next/server';
import { updateLearning, archiveLearning, cleanTags } from '@/lib/learnings';

export const dynamic = 'force-dynamic';

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const params = await ctx.params;
  try {
    const b = await req.json();
    const title = String(b.title || '').trim().slice(0, 200);
    const link = String(b.link || '').trim();
    if (!title) return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    if (link && !/^https?:\/\//i.test(link)) return NextResponse.json({ error: 'Link must start with http:// or https://' }, { status: 400 });
    return NextResponse.json(await updateLearning(params.id, { title, link, tags: cleanTags(b.tags), notes: String(b.notes || '').slice(0, 5000) }));
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

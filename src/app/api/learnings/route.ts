import { NextRequest, NextResponse } from 'next/server';
import { getLearnings, addLearning, cleanTags } from '@/lib/learnings';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ learnings: await getLearnings() });
  } catch (err: any) {
    return NextResponse.json({ learnings: [], error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const title = String(b.title || '').trim().slice(0, 200);
    const link = String(b.link || '').trim();
    if (!title) return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    if (link && !/^https?:\/\//i.test(link)) return NextResponse.json({ error: 'Link must start with http:// or https://' }, { status: 400 });
    const by = req.headers.get('x-roadmap-user') || '';
    const l = await addLearning({ title, link, tags: cleanTags(b.tags), notes: String(b.notes || '').slice(0, 5000) }, by);
    return NextResponse.json(l, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

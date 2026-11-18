import { NextRequest, NextResponse } from 'next/server';
import { getLearnings, addLearning, inputFromBody, badUrl } from '@/lib/learnings';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await getLearnings());
  } catch (err: any) {
    return NextResponse.json({ learnings: [], options: null, error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const input = inputFromBody(await req.json());
    if (!input.title) return NextResponse.json({ error: 'Title is required' }, { status: 400 });
    const bad = badUrl(input);
    if (bad) return NextResponse.json({ error: bad }, { status: 400 });
    const l = await addLearning(input, req.headers.get('x-roadmap-user') || '');
    return NextResponse.json(l, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

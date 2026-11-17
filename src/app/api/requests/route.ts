import { NextRequest, NextResponse } from 'next/server';
import { getRequests, addRequest, verifyApproverPassword } from '@/lib/clickup';

export const dynamic = 'force-dynamic';

// GET — list all pending requests (requires approver password)
export async function GET(req: NextRequest) {
  try {
    const password = req.headers.get('x-approver-password') || '';
    if (!verifyApproverPassword(password)) {
      return NextResponse.json({ error: 'Invalid approver password' }, { status: 401 });
    }
    return NextResponse.json(await getRequests());
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// POST — submit a new request (public). Creates a ClickUp task tagged as a request.
export async function POST(req: NextRequest) {
  try {
    const { name, pillar, month, priority, submittedBy, notes } = await req.json();
    if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 });
    if (!submittedBy?.trim()) return NextResponse.json({ error: 'Your name is required' }, { status: 400 });
    const item = await addRequest({
      name: name.trim(),
      pillar: pillar || '',
      month: month || '',
      priority: priority || 'Normal',
      submittedBy: submittedBy.trim(),
      notes: notes || '',
    });
    return NextResponse.json(item, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

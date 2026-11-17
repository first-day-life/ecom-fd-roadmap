import { NextRequest, NextResponse } from 'next/server';
import { approveRequest, rejectRequest, verifyApproverPassword } from '@/lib/clickup';

export const dynamic = 'force-dynamic';

// POST — approve a request (removes the request tag so it shows on the roadmap)
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { password } = await req.json();
    if (!verifyApproverPassword(password)) {
      return NextResponse.json({ error: 'Invalid approver password' }, { status: 401 });
    }
    const initiative = await approveRequest(params.id);
    return NextResponse.json({ success: true, initiative });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE — reject a request (archives the ClickUp task)
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { password } = await req.json();
    if (!verifyApproverPassword(password)) {
      return NextResponse.json({ error: 'Invalid approver password' }, { status: 401 });
    }
    await rejectRequest(params.id);
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

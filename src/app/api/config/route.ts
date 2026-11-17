import { NextResponse } from 'next/server';
import { testConnection } from '@/lib/clickup';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await testConnection());
}

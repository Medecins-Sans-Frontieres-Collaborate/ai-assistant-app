import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    { build: process.env.NEXT_PUBLIC_BUILD || 'unknown' },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

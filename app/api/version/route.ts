import { type NextRequest, NextResponse } from 'next/server';

export async function GET(_request: NextRequest) {
  const build = process.env.NEXT_PUBLIC_BUILD ?? 'unknown';

  return NextResponse.json(
    { build },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}

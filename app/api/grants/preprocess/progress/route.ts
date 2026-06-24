import { NextRequest, NextResponse } from 'next/server';

import { canAccessGrants } from '@/lib/services/grants/access';
import { preprocessProgressPath } from '@/lib/services/grants/preprocessProgress';

import { auth } from '@/auth';
import { readFileSync } from 'fs';

/**
 * GET /api/grants/preprocess/progress?runId=...
 *
 * Returns the live progress of an in-flight coverage-check run. The POST
 * handler writes a small JSON ({ status, label, percent }) to a temp file
 * keyed by runId; this reads it. Returns a "starting" placeholder if the
 * file doesn't exist yet (the run hasn't written its first tick).
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!canAccessGrants(session.user)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const runId = new URL(request.url).searchParams.get('runId');
  if (!runId) {
    return NextResponse.json({ error: 'Missing runId' }, { status: 400 });
  }

  try {
    const raw = readFileSync(preprocessProgressPath(runId), 'utf-8');
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({
      status: 'running',
      label: 'Starting…',
      percent: 0,
    });
  }
}

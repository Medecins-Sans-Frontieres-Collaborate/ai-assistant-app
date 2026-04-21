import { NextRequest, NextResponse } from 'next/server';

import { FileProcessingService } from '@/lib/services/chat/FileProcessingService';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { loadDocumentFromPath } from '@/lib/utils/server/file/fileHandling';
import { getContentType } from '@/lib/utils/server/file/mimeTypes';

import { auth } from '@/auth';

const USER_NAMESPACE_SEGMENTS = ['uploads/files', 'uploads/images'];

/**
 * True when the blob URL lives under the authenticated user's namespace.
 * We accept both absolute Azure URLs (where the path is `<container>/<userId>/uploads/...`)
 * and relative API references (`/api/file/<hash>.<ext>`) — for the latter we
 * only have the hash, so routing through the blob storage client below
 * re-applies the per-user prefix and the ownership check is implicit.
 */
function isBlobUrlOwnedByUser(url: string, userId: string): boolean {
  if (url.startsWith('/api/file/')) {
    // Hash-only reference; downloadFilePreferCached prefixes with the
    // authenticated userId, so cross-user access isn't possible.
    return true;
  }
  // Absolute blob URLs must contain the user's namespace segment. We don't
  // trust `startsWith` since the userId can appear anywhere — require
  // `/<userId>/uploads/(files|images)` to appear as a path segment.
  return USER_NAMESPACE_SEGMENTS.some((seg) =>
    url.includes(`/${userId}/${seg}/`),
  );
}

/**
 * Minimal placeholder endpoint for pre-processing files.
 * Accepts a single object { url } or an array of such objects, returns extracted text when cached.
 */
export async function POST(req: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body' },
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const items: Array<{ url: string }> = Array.isArray(body)
    ? (body as Array<{ url: string }>)
    : [body as { url: string }];

  const userId = getUserIdFromSession(session);
  for (const item of items) {
    if (!item?.url || typeof item.url !== 'string') continue;
    if (!isBlobUrlOwnedByUser(item.url, userId)) {
      return NextResponse.json(
        { error: 'Forbidden: blob does not belong to the authenticated user' },
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  const fps = new FileProcessingService();
  const limit = 3;
  const queue: Promise<{
    url: string;
    content: string;
    processedAt: string;
  }>[] = [];

  const runOne = async (url: string) => {
    const [, filePath] = fps.getTempFilePath(url);
    const { usedCache } = await fps.downloadFilePreferCached(
      url,
      filePath,
      session.user,
    );
    let content: string;
    if (usedCache) {
      const buf = await fps.readFile(filePath);
      content = buf.toString('utf-8');
    } else {
      const mimeType = getContentType(filePath);
      content = await loadDocumentFromPath(
        filePath,
        mimeType,
        filePath.split('/').pop() || 'file',
      );
    }
    await fps.cleanupFile(filePath);
    return {
      url,
      content,
      processedAt: new Date().toISOString(),
    };
  };

  try {
    const results: { url: string; content: string; processedAt: string }[] = [];
    for (const item of items) {
      if (!item?.url) continue;
      if (queue.length >= limit) {
        const r = await Promise.race(queue);
        results.push(r);
      }
      const p = runOne(item.url).finally(() => {
        const i = queue.indexOf(p);
        if (i >= 0) queue.splice(i, 1);
      });
      queue.push(p);
    }
    results.push(...(await Promise.all(queue)));
    return NextResponse.json(
      { results },
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('[api/file/process] Processing failed:', e);
    const message = e instanceof Error ? e.message : 'Processing failed';
    return NextResponse.json(
      { error: message, code: 'PROCESSING_FAILED' },
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

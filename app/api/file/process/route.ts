import { NextRequest, NextResponse } from 'next/server';

import { FileProcessingService } from '@/lib/services/chat/FileProcessingService';
import { isDocumentIntelligenceConfigured } from '@/lib/services/documentIntelligence/client';

import { getUserIdFromSession } from '@/lib/utils/app/user/session';
import { isBlobUrlOwnedByUser } from '@/lib/utils/server/file/blobOwnership';
import {
  NoExtractableTextError,
  loadDocumentFromPath,
} from '@/lib/utils/server/file/fileHandling';
import { getContentType } from '@/lib/utils/server/file/mimeTypes';
import { sanitizeForLog } from '@/lib/utils/server/log/logSanitization';

import { auth } from '@/auth';

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

  const runOne = async (url: string) => {
    const [, filePath] = fps.getTempFilePath(url);
    try {
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
      return {
        url,
        content,
        processedAt: new Date().toISOString(),
      };
    } finally {
      await fps.cleanupFile(filePath);
    }
  };

  try {
    const results: Array<Awaited<ReturnType<typeof runOne>>> = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        const item = items[index];
        if (!item?.url) continue;
        results[index] = await runOne(item.url);
      }
    };
    // Await every worker even when one fails, so in-flight files are cleaned
    // before responding. Store results by index: simultaneous completions
    // must not be dropped or reorder the requested documents.
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(limit, items.length) }, worker),
    );
    const failure = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return NextResponse.json(
      {
        results: results.filter(Boolean),
        // Lets the client offer OCR for text that came out thin.
        ocrAvailable: isDocumentIntelligenceConfigured(),
      },
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    if (e instanceof NoExtractableTextError) {
      return NextResponse.json(
        {
          error: e.message,
          code: 'NO_EXTRACTABLE_TEXT',
          // The file is stored; the client may offer to read it with OCR.
          ocrAvailable: isDocumentIntelligenceConfigured(),
        },
        { status: 422, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // Error message can surface user-provided URLs / filenames from blob
    // download failures — sanitize before logging to prevent log forging.
    console.error('[api/file/process] Processing failed:', sanitizeForLog(e));
    const message = e instanceof Error ? e.message : 'Processing failed';
    return NextResponse.json(
      { error: message, code: 'PROCESSING_FAILED' },
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

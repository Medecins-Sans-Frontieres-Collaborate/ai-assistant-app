// app/api/document-translation/[jobId]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  DocumentTranslationStatusResponse,
} from '@/types/document';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BACKEND_BASE_URL = process.env.DOCUMENT_TRANSLATOR_BASE_URL;
const BACKEND_API_KEY = process.env.DOCUMENT_TRANSLATOR_API_KEY;

if (!BACKEND_BASE_URL) {
  console.error('[document-translation-status] Missing DOCUMENT_TRANSLATOR_BASE_URL');
}
if (!BACKEND_API_KEY) {
  console.error('[document-translation-status] Missing DOCUMENT_TRANSLATOR_API_KEY');
}

// GET /api/document-translation/:jobId
export async function GET(
  _req: NextRequest,
  ctx: { params: { jobId: string } },
) {
  if (!BACKEND_BASE_URL || !BACKEND_API_KEY) {
    return NextResponse.json(
      {
        error:
          'Server misconfigured: DOCUMENT_TRANSLATOR_BASE_URL or DOCUMENT_TRANSLATOR_API_KEY not set.',
      },
      { status: 500 },
    );
  }

  const { jobId } = ctx.params;

  if (!jobId) {
    return NextResponse.json(
      { error: 'Missing jobId in route params.' },
      { status: 400 },
    );
  }

  try {
    // Backend still wants POST with JSON body { job_id }
    const backendRes = await fetch(
      new URL('/translate/status', BACKEND_BASE_URL).toString(),
      {
        method: 'POST',
        headers: {
          'x-api-key': BACKEND_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ job_id: jobId }),
      },
    );

    if (!backendRes.ok) {
      let payload: unknown = null;
      try {
        payload = await backendRes.json();
      } catch {
        try {
          const text = await backendRes.text();
          payload = { message: text };
        } catch {
          payload = null;
        }
      }

      return NextResponse.json(
        {
          error: 'Status check failed on translation backend',
          status: backendRes.status,
          backend: payload,
        },
        { status: backendRes.status },
      );
    }

    const statusJson = (await backendRes.json()) as DocumentTranslationStatusResponse;

    return NextResponse.json(statusJson, { status: 200 });
  } catch (error) {
    console.error('[document-translation-status] Proxy error:', error);
    return NextResponse.json(
      { error: 'Internal document translation status proxy error' },
      { status: 500 },
    );
  }
}

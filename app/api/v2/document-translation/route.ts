import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import {
  DocumentUploadResponse,
  DocumentTranslationResponse,
} from '@/types/document';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BACKEND_BASE_URL = process.env.DOCUMENT_TRANSLATOR_BASE_URL;
const BACKEND_API_KEY = process.env.DOCUMENT_TRANSLATOR_API_KEY;

if (!BACKEND_BASE_URL) {
  console.error('[document-translation] Missing DOCUMENT_TRANSLATOR_BASE_URL');
}
if (!BACKEND_API_KEY) {
  console.error('[document-translation] Missing DOCUMENT_TRANSLATOR_API_KEY');
}

export async function POST(req: NextRequest) {
  if (!BACKEND_BASE_URL || !BACKEND_API_KEY) {
    return NextResponse.json(
      {
        error:
          'Server misconfigured: DOCUMENT_SERVICE_BASE_URL or DOCUMENT_SERVICE_API_KEY not set.',
      },
      { status: 500 },
    );
  }

  try {
    const formData = await req.formData();

    const file = formData.get('file');
    const sourceLanguage =
      (formData.get('sourceLanguage') ??
        formData.get('source_lang')) || undefined;
    const targetLanguage =
      (formData.get('targetLanguage') ??
        formData.get('target_lang')) || undefined;

    if (!(file instanceof Blob)) {
      return NextResponse.json(
        { error: 'Missing or invalid "file" in form data.' },
        { status: 400 },
      );
    }

    if (!targetLanguage || typeof targetLanguage !== 'string') {
      return NextResponse.json(
        { error: 'Missing "targetLanguage" / "target_lang".' },
        { status: 400 },
      );
    }

    if (!sourceLanguage || typeof sourceLanguage !== 'string') {
      return NextResponse.json(
        { error: 'Missing "sourceLanguage" / "source_lang".' },
        { status: 400 },
      );
    }

    // ---------- 1) UPLOAD STEP: /upload ----------
    const uploadForm = new FormData();
    // preserve original filename if available
    const filename =
      (file as File).name ??
      (formData.get('fileName') as string | null) ??
      'document';

    uploadForm.append('file', file, filename);

    const uploadRes = await fetch(
      new URL('/upload', BACKEND_BASE_URL).toString(),
      {
        method: 'POST',
        headers: {
          'x-api-key': BACKEND_API_KEY,
          // no content-type: let fetch generate boundary
        },
        body: uploadForm,
      },
    );

    if (!uploadRes.ok) {
      let payload: unknown = null;
      try {
        payload = await uploadRes.json();
      } catch {
        try {
          const text = await uploadRes.text();
          payload = { message: text };
        } catch {
          payload = null;
        }
      }

      return NextResponse.json(
        {
          error: 'Upload failed on translation backend',
          status: uploadRes.status,
          backend: payload,
        },
        { status: uploadRes.status },
      );
    }

    const uploadJson = (await uploadRes.json()) as DocumentUploadResponse;

    if (!uploadJson.file_name || typeof uploadJson.file_name !== 'string') {
      return NextResponse.json(
        {
          error:
            'Upload response did not contain a valid "blob_name". Cannot start translation.',
          backend: uploadJson,
        },
        { status: 500 },
      );
    }

    const blobName = uploadJson.file_name;

    // ---------- 2) TRANSLATE STEP: /translate ----------
    const translateBody = {
      blob_name: blobName,
      source_lang: sourceLanguage,
      target_lang: targetLanguage,
    };

    const translateRes = await fetch(
      new URL('/translate', BACKEND_BASE_URL).toString(),
      {
        method: 'POST',
        headers: {
          'x-api-key': BACKEND_API_KEY,
          'content-type': 'application/json',
        },
        body: JSON.stringify(translateBody),
      },
    );

    if (!translateRes.ok) {
      let payload: unknown = null;
      try {
        payload = await translateRes.json();
      } catch {
        try {
          const text = await translateRes.text();
          payload = { message: text };
        } catch {
          payload = null;
        }
      }

      return NextResponse.json(
        {
          error: 'Translate failed on translation backend',
          status: translateRes.status,
          backend: payload,
        },
        { status: translateRes.status },
      );
    }

    const translateJson =
      (await translateRes.json()) as DocumentTranslationResponse;

    // This should match your DocumentTranslationResponse schema
    // {
    //   job_id: string;
    //   target_sas_url: string;
    // }

    return NextResponse.json(
      {
        ...translateJson,
        // optionally surface the blob_name + upload info so the client
        // can correlate / show cost / status if needed
        blob_name: blobName,
        upload: uploadJson,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error('[document-translation] Proxy orchestration error:', error);

    return NextResponse.json(
      { error: 'Internal document translation proxy error' },
      { status: 500 },
    );
  }
}

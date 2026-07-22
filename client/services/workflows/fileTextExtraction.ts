'use client';

/**
 * Uploads a file to blob storage and returns its extracted plain text.
 * Shared by the workflow workspaces (document references, translation
 * source upload, data extraction sources, map inputs) — same
 * `/api/file/upload` → `/api/file/process` path the chat surface uses, so
 * extraction, caching, and per-user namespacing are identical.
 */

export interface ExtractedFileText {
  /** Blob reference (relative /api/file/... or absolute URL). */
  url: string;
  name: string;
  text: string;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Plain-text types we can read locally without an upload round-trip. */
const LOCAL_TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

const LOCAL_TEXT_EXTENSIONS = /\.(txt|md|csv|json|tsv)$/i;

export async function uploadAndExtractText(
  file: File,
): Promise<ExtractedFileText> {
  // Cheap path: plain-text files are read in the browser.
  if (
    LOCAL_TEXT_TYPES.has(file.type) ||
    LOCAL_TEXT_EXTENSIONS.test(file.name)
  ) {
    const text = await file.text();
    return { url: '', name: file.name, text };
  }

  const base64Data = await readAsBase64(file);
  const encodedFileName = encodeURIComponent(file.name);
  const encodedMimeType = encodeURIComponent(file.type);

  const uploadResponse = await fetch(
    `/api/file/upload?filename=${encodedFileName}&filetype=file&mime=${encodedMimeType}`,
    {
      method: 'POST',
      body: base64Data,
      headers: { 'x-file-name': encodedFileName },
    },
  );
  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json().catch(() => ({}));
    throw new Error(
      errorData.error || `Upload failed (${uploadResponse.status})`,
    );
  }
  const uploadData = (await uploadResponse.json()) as { uri: string };

  const processResponse = await fetch('/api/file/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: uploadData.uri }),
  });
  if (!processResponse.ok) {
    const errorData = await processResponse.json().catch(() => ({}));
    throw new Error(
      errorData.error || `Text extraction failed (${processResponse.status})`,
    );
  }
  const processData = (await processResponse.json()) as {
    results: Array<{ url: string; content: string }>;
  };
  const content = processData.results?.[0]?.content ?? '';

  return { url: uploadData.uri, name: file.name, text: content };
}

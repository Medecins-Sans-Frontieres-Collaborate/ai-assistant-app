import { act, renderHook, waitFor } from '@testing-library/react';

import { useUrlAttachment } from '@/client/hooks/chat/useUrlAttachment';

import type { FilePreview } from '@/types/chat';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetchUrlContent = vi.hoisted(() => vi.fn());
const mockOnFileUpload = vi.hoisted(() => vi.fn());

vi.mock('@/client/services/url/urlFetchClient', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/client/services/url/urlFetchClient')
    >();
  return { ...actual, fetchUrlContent: mockFetchUrlContent };
});

// Stand in for the real upload pipeline: append a completed preview, and
// record the File so we can inspect the content that would be sent.
vi.mock('@/client/handlers/chatInput/file-upload', () => ({
  onFileUpload: mockOnFileUpload,
}));

vi.mock('next-intl', () => ({
  // Echo the key so assertions can identify which string was chosen.
  useTranslations: () => (key: string) => key,
}));

const uploadedFiles: File[] = [];

/** jsdom's File has no `.text()`, so read through FileReader instead. */
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function resetStore() {
  useChatInputStore.setState({ filePreviews: [] });
  uploadedFiles.length = 0;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  mockOnFileUpload.mockImplementation(
    async (
      files: File[],
      _setSubmitType: unknown,
      setFilePreviews: (
        updater: (prev: FilePreview[]) => FilePreview[],
      ) => void,
    ) => {
      uploadedFiles.push(...files);
      setFilePreviews((prev) => [
        ...prev,
        ...files.map((file) => ({
          name: file.name,
          type: file.type,
          status: 'completed' as const,
          previewUrl: '',
          uploadedUrl: `/api/file/${file.name}`,
        })),
      ]);
    },
  );
});

const previews = () => useChatInputStore.getState().filePreviews;

describe('useUrlAttachment — successful fetch', () => {
  beforeEach(() => {
    mockFetchUrlContent.mockResolvedValue({
      ok: true,
      page: {
        text: 'Floodwaters reached Bor on Tuesday.',
        title: 'Floods in Jonglei',
        siteName: 'Example News',
        resolvedUrl: 'https://news.example.com/floods',
        truncated: false,
        extractedVia: 'readability',
      },
    });
  });

  it('attaches the page text and marks the tile as coming from a link', async () => {
    const { result } = renderHook(() => useUrlAttachment());

    await act(async () => {
      await result.current.attachUrl('https://news.example.com/floods');
    });

    await waitFor(() => expect(previews()).toHaveLength(1));
    const preview = previews()[0];
    expect(preview.sourceUrl).toBe('https://news.example.com/floods');
    expect(preview.sourceError).toBeUndefined();
    expect(preview.status).toBe('completed');

    expect(uploadedFiles).toHaveLength(1);
    await expect(readFile(uploadedFiles[0])).resolves.toContain(
      'Floodwaters reached Bor on Tuesday.',
    );
  });

  it('removes the in-flight placeholder', async () => {
    const { result } = renderHook(() => useUrlAttachment());

    await act(async () => {
      await result.current.attachUrl('https://news.example.com/floods');
    });

    expect(previews().every((p) => p.status !== 'pending')).toBe(true);
  });

  it('ignores the same link twice', async () => {
    const { result } = renderHook(() => useUrlAttachment());

    await act(async () => {
      await result.current.attachUrl('https://news.example.com/floods');
      await result.current.attachUrl('https://news.example.com/floods');
    });

    expect(previews()).toHaveLength(1);
    expect(mockFetchUrlContent).toHaveBeenCalledTimes(1);
  });

  /**
   * Dedupe keys off the URL as pasted. Tagging the tile with the *resolved*
   * URL instead would stop a repeat paste matching, so a redirecting link
   * would silently attach twice.
   */
  it('still dedupes when the server followed a redirect', async () => {
    mockFetchUrlContent.mockResolvedValue({
      ok: true,
      page: {
        text: 'Body text.',
        title: 'Floods in Jonglei',
        siteName: 'Example News',
        resolvedUrl: 'https://www.news.example.com/floods/',
        truncated: false,
        extractedVia: 'readability',
      },
    });
    const { result } = renderHook(() => useUrlAttachment());

    await act(async () => {
      await result.current.attachUrl('news.example.com/floods');
      await result.current.attachUrl('news.example.com/floods');
    });

    expect(previews()).toHaveLength(1);
    expect(previews()[0].sourceUrl).toBe('news.example.com/floods');
    expect(mockFetchUrlContent).toHaveBeenCalledTimes(1);
  });
});

describe('useUrlAttachment — failed fetch', () => {
  beforeEach(() => {
    mockFetchUrlContent.mockResolvedValue({ ok: false, code: 'BLOCKED' });
  });

  /**
   * The core contract: a failure must not leave the user with nothing. The
   * attachment is still created, still uploaded, and its content explains
   * what happened — so the model is told why the link is empty.
   */
  it('still attaches a document explaining the failure', async () => {
    const { result } = renderHook(() => useUrlAttachment());

    await act(async () => {
      await result.current.attachUrl('https://paywalled.example.com/x');
    });

    expect(uploadedFiles).toHaveLength(1);
    const content = await readFile(uploadedFiles[0]);
    expect(content).toContain('doc.failureHeading');
    expect(content).toContain('https://paywalled.example.com/x');
    expect(content).toContain('errors.blocked');
    expect(content).toContain('fallbackHint');
  });

  it('marks the tile with sourceError but leaves status completed', async () => {
    const { result } = renderHook(() => useUrlAttachment());

    await act(async () => {
      await result.current.attachUrl('https://paywalled.example.com/x');
    });

    await waitFor(() => expect(previews()).toHaveLength(1));
    const preview = previews()[0];
    expect(preview.sourceError).toBe('errors.blocked');
    // 'failed' would exclude the attachment from the outgoing payload — the
    // upload genuinely succeeded, so status must stay completed.
    expect(preview.status).toBe('completed');
  });

  it('leaves no pending preview that could block sending', async () => {
    const { result } = renderHook(() => useUrlAttachment());

    await act(async () => {
      await result.current.attachUrl('https://paywalled.example.com/x');
    });

    expect(
      previews().some(
        (p) =>
          p.status === 'pending' ||
          p.status === 'uploading' ||
          p.status === 'extracting',
      ),
    ).toBe(false);
  });
});

describe('useUrlAttachment — input guards', () => {
  it('does nothing for an empty URL', async () => {
    const { result } = renderHook(() => useUrlAttachment());

    await act(async () => {
      await result.current.attachUrl('   ');
    });

    expect(mockFetchUrlContent).not.toHaveBeenCalled();
    expect(previews()).toHaveLength(0);
  });
});

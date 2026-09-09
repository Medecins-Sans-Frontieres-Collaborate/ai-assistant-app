/**
 * M365 attachment bookkeeping — specifically that placeholder removal and
 * tile tagging are keyed by the unique sourceKey, not the display name:
 * two different drive items can both be called report.docx, and one
 * completing must never remove or retag the other's tile. The translation
 * mock echoes bare keys, which makes both placeholders share a name —
 * the harshest version of the collision.
 */
import { act, renderHook, waitFor } from '@testing-library/react';

import { useM365Attachment } from '@/client/hooks/chat/useM365Attachment';

import { downloadDriveItem } from '@/client/services/m365/m365Client';

import type { FilePreview } from '@/types/chat';
import type { M365DriveEntry } from '@/types/m365';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOnFileUpload = vi.hoisted(() => vi.fn());

vi.mock('@/client/hooks/useM365Enabled', () => ({
  useM365Enabled: () => ({ transcriptionEnabled: false }),
}));

vi.mock('@/client/services/m365/m365Client', () => {
  class M365ClientError extends Error {
    constructor(
      message: string,
      readonly code?: string,
    ) {
      super(message);
      this.name = 'M365ClientError';
    }
  }
  return {
    M365ClientError,
    downloadDriveItem: vi.fn(),
    fetchMailImport: vi.fn(),
    importDriveItemToStorage: vi.fn(),
  };
});

// Stand in for the real upload pipeline: append a completed preview per
// file, exactly like the real onFileUpload does on success.
vi.mock('@/client/handlers/chatInput/file-upload', () => ({
  onFileUpload: mockOnFileUpload,
}));

vi.mock('next-intl', () => ({
  // Echo the key so assertions can identify which string was chosen.
  useTranslations: () => (key: string) => key,
}));

const downloadDriveItemMock = vi.mocked(downloadDriveItem);

function entry(overrides: Partial<M365DriveEntry> = {}): M365DriveEntry {
  return {
    driveId: 'd1',
    itemId: 'i1',
    name: 'report.docx',
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    webUrl: 'https://contoso.example/a',
    ...overrides,
  } as M365DriveEntry;
}

const previews = () => useChatInputStore.getState().filePreviews;

beforeEach(() => {
  vi.clearAllMocks();
  useChatInputStore.setState({ filePreviews: [] });
  mockOnFileUpload.mockImplementation(
    async (
      files: File[],
      _setSubmitType: unknown,
      setFilePreviews: (
        updater: (prev: FilePreview[]) => FilePreview[],
      ) => void,
    ) => {
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

describe('useM365Attachment — same-named files (M10)', () => {
  it('keeps both attachments distinct when two different files share a name', async () => {
    const entryA = entry({
      itemId: 'iA',
      webUrl: 'https://contoso.example/a',
    });
    const entryB = entry({
      itemId: 'iB',
      webUrl: 'https://contoso.example/b',
    });
    const resolvers: Array<
      (value: { blob: Blob; name: string; webUrl?: string }) => void
    > = [];
    downloadDriveItemMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const { result } = renderHook(() => useM365Attachment());
    let attachA!: Promise<void>;
    let attachB!: Promise<void>;
    act(() => {
      attachA = result.current.attachDriveItem(entryA);
      attachB = result.current.attachDriveItem(entryB);
    });

    // Both placeholders in flight, keyed by their own source.
    expect(previews().filter((p) => p.status === 'pending')).toHaveLength(2);

    // A finishes first — B's placeholder must survive.
    await act(async () => {
      resolvers[0]({
        blob: new Blob(['a']),
        name: 'report.docx',
        webUrl: 'https://contoso.example/a',
      });
      await attachA;
    });
    const stillPending = previews().filter((p) => p.status === 'pending');
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0].sourceUrl).toBe('https://contoso.example/b');

    await act(async () => {
      resolvers[1]({
        blob: new Blob(['b']),
        name: 'report.docx',
        webUrl: 'https://contoso.example/b',
      });
      await attachB;
    });

    // Two completed tiles, each tagged with its OWN source — not both
    // stamped with whichever finished last.
    await waitFor(() => expect(previews()).toHaveLength(2));
    expect(previews().every((p) => p.status === 'completed')).toBe(true);
    expect(new Set(previews().map((p) => p.sourceUrl))).toEqual(
      new Set(['https://contoso.example/a', 'https://contoso.example/b']),
    );
  });

  it('tags each same-named failure document with its own source', async () => {
    const { M365ClientError } =
      await import('@/client/services/m365/m365Client');
    downloadDriveItemMock.mockRejectedValue(
      new M365ClientError('nope', 'M365_FORBIDDEN'),
    );
    const { result } = renderHook(() => useM365Attachment());

    await act(async () => {
      await result.current.attachDriveItem(
        entry({ itemId: 'iA', webUrl: 'https://contoso.example/a' }),
      );
    });
    await act(async () => {
      await result.current.attachDriveItem(
        entry({ itemId: 'iB', webUrl: 'https://contoso.example/b' }),
      );
    });

    // Both failure docs share the name report.docx-unavailable.md; the
    // second failure must not retag the first tile.
    expect(previews()).toHaveLength(2);
    expect(previews().map((p) => p.name)).toEqual([
      'report.docx-unavailable.md',
      'report.docx-unavailable.md',
    ]);
    expect(previews().map((p) => p.sourceUrl)).toEqual([
      'https://contoso.example/a',
      'https://contoso.example/b',
    ]);
    expect(previews().every((p) => p.sourceError === 'errors.forbidden')).toBe(
      true,
    );
    expect(previews().every((p) => p.status === 'completed')).toBe(true);
  });

  it('still dedupes a repeat of the SAME file', async () => {
    downloadDriveItemMock.mockResolvedValue({
      blob: new Blob(['a']),
      name: 'report.docx',
      webUrl: 'https://contoso.example/a',
    });
    const { result } = renderHook(() => useM365Attachment());

    await act(async () => {
      await result.current.attachDriveItem(entry());
      await result.current.attachDriveItem(entry());
    });

    expect(previews()).toHaveLength(1);
    expect(downloadDriveItemMock).toHaveBeenCalledTimes(1);
  });
});

import { uploadFileAction } from '@/lib/actions/fileUpload';
import { format } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadDocument, upload } = vi.hoisted(() => ({
  loadDocument: vi.fn(),
  upload: vi.fn(),
}));

vi.mock('@/auth', () => ({
  auth: vi.fn(async () => ({ user: { id: 'user-1' } })),
}));
vi.mock('@/lib/utils/app/user/session', () => ({
  getUserIdFromSession: () => 'user-1',
}));
vi.mock('@/lib/services/limits/uploadLimit', () => ({
  resolveEffectiveUploadMegabytes: vi.fn(async () => undefined),
}));
vi.mock('@/lib/services/blobStorageFactory', () => ({
  createBlobStorageClient: () => ({ upload }),
}));
vi.mock('@/lib/utils/server/blob/blob', () => ({
  AzureBlobStorage: class {},
  BlobProperty: { URL: 'url', BLOB: 'blob' },
}));
vi.mock('@/lib/utils/server/file/fileHandling', () => ({ loadDocument }));

describe('upload text-cache logging', () => {
  beforeEach(() => {
    loadDocument.mockReset();
    upload.mockReset().mockResolvedValue('https://blob.local/document.pdf');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['empty', 'success', 'failure'] as const)(
    'sanitizes the %s log without changing the filename or document content',
    async (outcome) => {
      const filename = 'report%s%d%j\r\nFORGED\u001b[31m.pdf';
      const content = 'document\ncontent';
      if (outcome === 'failure') {
        loadDocument.mockRejectedValue(new Error('Parse\nFORGED\u001b[31m'));
      } else {
        loadDocument.mockResolvedValue(outcome === 'empty' ? '' : content);
      }
      const level =
        outcome === 'empty' ? 'warn' : outcome === 'success' ? 'log' : 'error';
      const log = vi.spyOn(console, level).mockImplementation(() => {});
      const data = new FormData();
      data.set('file', new File(['%PDF-1.7'], filename));
      data.set('filename', filename);
      data.set('filetype', 'file');
      data.set('mime', 'application/pdf');

      expect((await uploadFileAction(data)).success).toBe(true);
      await vi.waitFor(() => expect(log).toHaveBeenCalled());

      const entry = log.mock.calls.find(([message]) =>
        String(message).startsWith('[TextCache]'),
      );
      expect(entry).toBeDefined();
      for (const value of entry!) {
        expect(typeof value).toBe('string');
        // eslint-disable-next-line no-control-regex
        expect(value).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      }
      const rendered = format(...entry!);
      expect(rendered).toContain('report%s%d%j FORGED[31m.pdf');
      if (outcome === 'failure') {
        expect(rendered).toBe(
          '[TextCache] Failed to cache text for report%s%d%j FORGED[31m.pdf: Parse FORGED[31m',
        );
      }
      expect(loadDocument.mock.calls[0][0].name).toBe(filename);
      if (outcome === 'success') {
        expect(upload).toHaveBeenCalledWith(
          expect.stringContaining('.cached.txt'),
          content,
          expect.anything(),
        );
      }
    },
  );
});

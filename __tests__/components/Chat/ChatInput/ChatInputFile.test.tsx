// ───────────────────────────────────────────────────────────────────
// ChatInputFile / useUploadLimitSync — feeds the caller's resolved
// `feature.upload.megabytesPerFile` into FileUploadService so the size
// check runs before an upload starts (docs/LIMITS_USER_FACING_UX.md §7.4).
// ───────────────────────────────────────────────────────────────────
import { render, renderHook, screen } from '@testing-library/react';
import React from 'react';

import type { MeLimit } from '@/client/hooks/settings/useMyLimits';

import { FileUploadService } from '@/client/services/fileUploadService';

import ChatInputFile, {
  useEffectiveUploadMegabytes,
  useUploadLimitSync,
} from '@/components/Chat/ChatInput/ChatInputFile';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The service module imports the upload Server Actions; keep Azure out.
vi.mock('@/lib/actions/fileUpload', () => ({
  initChunkedUploadAction: vi.fn(),
  uploadChunkAction: vi.fn(),
  finalizeChunkedUploadAction: vi.fn(),
  cancelChunkedUploadAction: vi.fn(),
  uploadFileAction: vi.fn(),
}));
vi.mock('@/lib/services/imageService', () => ({ cacheImageBase64: vi.fn() }));

let enforce = true;
let limits: MeLimit[] = [];

vi.mock('@/client/hooks/settings/useMyLimits', () => ({
  useMyLimits: () => ({ enforce, limits, models: {}, refetch: vi.fn() }),
}));

const MB = 1024 * 1024;

function row(partial: Partial<MeLimit>): MeLimit {
  return {
    limitKey: 'feature.upload.megabytesPerFile',
    value: 20,
    unit: 'megabytes',
    window: 'request',
    source: 'policy',
    ...partial,
  };
}

function renderInput() {
  return render(
    <ChatInputFile
      onFileUpload={vi.fn()}
      setSubmitType={vi.fn()}
      setFilePreviews={vi.fn()}
      setFileFieldValue={vi.fn()}
      setImageFieldValue={vi.fn()}
      setUploadProgress={vi.fn()}
    />,
  );
}

describe('useEffectiveUploadMegabytes', () => {
  beforeEach(() => {
    enforce = true;
    limits = [];
  });

  it('is undefined with no upload row (fail open)', () => {
    limits = [row({ limitKey: 'chat.messagesPerDay', value: 50 })];
    expect(renderHook(() => useEffectiveUploadMegabytes()).result.current).toBe(
      undefined,
    );
  });

  it('reads the numeric unqualified row', () => {
    limits = [row({ value: 20 })];
    expect(renderHook(() => useEffectiveUploadMegabytes()).result.current).toBe(
      20,
    );
  });

  it('ignores a null (unlimited) row and any model-qualified row', () => {
    limits = [row({ value: null }), row({ value: 5, modelId: 'gpt-5.2' })];
    expect(renderHook(() => useEffectiveUploadMegabytes()).result.current).toBe(
      undefined,
    );
  });

  it('is undefined when the policy is not enforced (observe / outage / flag off)', () => {
    enforce = false;
    limits = [row({ value: 20 })];
    expect(renderHook(() => useEffectiveUploadMegabytes()).result.current).toBe(
      undefined,
    );
  });
});

describe('useUploadLimitSync → FileUploadService', () => {
  beforeEach(() => {
    enforce = true;
    limits = [];
    FileUploadService.setEffectiveUploadLimit(null);
  });
  afterEach(() => {
    FileUploadService.setEffectiveUploadLimit(null);
  });

  it('publishes the cap with a localized message and clears it on unmount', () => {
    limits = [row({ value: 10 })];
    const { unmount } = renderHook(() => useUploadLimitSync());
    expect(FileUploadService.getEffectiveUploadLimit()?.megabytes).toBe(10);

    // The same validateFile → toast path the compiled caps use, now with
    // the admin cap and the limitsUx.routes copy.
    const tooBig = FileUploadService.validateFile({
      name: 'deck.pdf',
      type: 'application/pdf',
      size: 11 * MB,
    } as unknown as File);
    expect(tooBig.valid).toBe(false);
    expect(tooBig.error).toBe('uploadTooLarge');

    unmount();
    expect(FileUploadService.getEffectiveUploadLimit()).toBeNull();
  });

  it('leaves the service untouched when no cap resolves', () => {
    renderHook(() => useUploadLimitSync());
    expect(FileUploadService.getEffectiveUploadLimit()).toBeNull();
  });

  it('follows the cap as the limits payload changes', () => {
    limits = [row({ value: 10 })];
    const { rerender } = renderHook(() => useUploadLimitSync());
    expect(FileUploadService.getEffectiveUploadLimit()?.megabytes).toBe(10);
    limits = [row({ value: 25 })];
    rerender();
    expect(FileUploadService.getEffectiveUploadLimit()?.megabytes).toBe(25);
    limits = [];
    rerender();
    expect(FileUploadService.getEffectiveUploadLimit()).toBeNull();
  });
});

describe('ChatInputFile', () => {
  beforeEach(() => {
    enforce = true;
    limits = [];
    FileUploadService.setEffectiveUploadLimit(null);
  });
  afterEach(() => {
    FileUploadService.setEffectiveUploadLimit(null);
  });

  it('mounts the sync and shows the cap in the tooltip when it undercuts every compiled category cap', () => {
    // Below the smallest compiled category cap (images, 5MB): the hint's
    // promise ("Files up to …") genuinely holds for anything the user can
    // attach.
    limits = [row({ value: 3 })];
    renderInput();
    expect(FileUploadService.getEffectiveUploadLimit()?.megabytes).toBe(3);
    expect(screen.getByText('uploadCapHint')).toBeInTheDocument();
  });

  it("renders today's tooltip alone without a cap", () => {
    renderInput();
    expect(screen.queryByText('uploadCapHint')).not.toBeInTheDocument();
    expect(FileUploadService.getEffectiveUploadLimit()).toBeNull();
  });

  it('hides the cap hint when the admin cap does not undercut every compiled category cap', () => {
    // A 20MB admin cap is above the compiled 5MB image cap, so "Files up to
    // 20MB" would be false for images (validateFile still refuses a 6MB PNG
    // at the compiled cap). The sync still publishes the cap for
    // validateFile — only the promise-shaped tooltip line is suppressed.
    limits = [row({ value: 20 })];
    renderInput();
    expect(FileUploadService.getEffectiveUploadLimit()?.megabytes).toBe(20);
    expect(screen.queryByText('uploadCapHint')).not.toBeInTheDocument();
  });
});

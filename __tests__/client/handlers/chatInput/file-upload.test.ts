import { onFileUpload } from '@/client/handlers/chatInput/file-upload';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture what gets sent to the upload service so we can assert on the
// fallback behavior.
const uploadMultipleFilesMock = vi.fn(async () => [] as unknown[]);
vi.mock('@/client/services/fileUploadService', () => ({
  FileUploadService: {
    uploadMultipleFiles: (...args: unknown[]) =>
      uploadMultipleFilesMock(...args),
  },
}));

const isVideoFileMock = vi.fn();
vi.mock('@/lib/utils/client/file/fileValidation', () => ({
  isVideoFile: (...args: unknown[]) => isVideoFileMock(...args),
}));

const isAudioExtractionSupportedMock = vi.fn();
const extractAudioFromVideoMock = vi.fn();
vi.mock('@/lib/utils/client/audio/audioExtractor', () => {
  // Inline the class so vi.mock's hoisted factory doesn't reference an
  // out-of-order top-level binding.
  class AudioExtractionUnavailableError extends Error {
    constructor(
      message: string,
      public readonly reason: 'cdn' | 'memory',
    ) {
      super(message);
      this.name = 'AudioExtractionUnavailableError';
    }
  }
  return {
    isAudioExtractionSupported: (...args: unknown[]) =>
      isAudioExtractionSupportedMock(...args),
    extractAudioFromVideo: (...args: unknown[]) =>
      extractAudioFromVideoMock(...args),
    AudioExtractionUnavailableError,
  };
});

vi.mock('react-hot-toast', () => {
  const fn = Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  });
  return { default: fn };
});

function makeVideoFile(): File {
  return {
    name: 'clip.mp4',
    type: 'video/mp4',
    size: 1024,
  } as unknown as File;
}

describe('onFileUpload AudioExtractionUnavailableError fallback', () => {
  let setSubmitType: ReturnType<typeof vi.fn>;
  let setFilePreviews: ReturnType<typeof vi.fn>;
  let setFileFieldValue: ReturnType<typeof vi.fn>;
  let setImageFieldValue: ReturnType<typeof vi.fn>;
  let setUploadProgress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    uploadMultipleFilesMock.mockClear();
    uploadMultipleFilesMock.mockResolvedValue([]);
    isVideoFileMock.mockResolvedValue(true);
    isAudioExtractionSupportedMock.mockReturnValue(true);
    extractAudioFromVideoMock.mockReset();
    setSubmitType = vi.fn();
    setFilePreviews = vi.fn();
    setFileFieldValue = vi.fn();
    setImageFieldValue = vi.fn();
    setUploadProgress = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads the raw video when extraction throws AudioExtractionUnavailableError', async () => {
    extractAudioFromVideoMock.mockRejectedValue(
      new AudioExtractionUnavailableErrorMock('cdn blocked', 'cdn'),
    );

    await onFileUpload(
      [makeVideoFile()],
      setSubmitType,
      setFilePreviews,
      setFileFieldValue,
      setImageFieldValue,
      setUploadProgress,
    );

    expect(uploadMultipleFilesMock).toHaveBeenCalledTimes(1);
    const filesPassedToUpload = uploadMultipleFilesMock.mock.calls[0][0] as
      | File[]
      | undefined;
    expect(filesPassedToUpload).toHaveLength(1);
    expect(filesPassedToUpload?.[0]?.name).toBe('clip.mp4');
    expect(filesPassedToUpload?.[0]?.type).toBe('video/mp4');
  });

  it('uploads the raw video when isAudioExtractionSupported(file) returns false', async () => {
    isAudioExtractionSupportedMock.mockReturnValue(false);

    await onFileUpload(
      [makeVideoFile()],
      setSubmitType,
      setFilePreviews,
      setFileFieldValue,
      setImageFieldValue,
      setUploadProgress,
    );

    // Extraction is never attempted in this branch.
    expect(extractAudioFromVideoMock).not.toHaveBeenCalled();
    expect(uploadMultipleFilesMock).toHaveBeenCalledTimes(1);
    const filesPassedToUpload = uploadMultipleFilesMock.mock.calls[0][0] as
      | File[]
      | undefined;
    expect(filesPassedToUpload).toHaveLength(1);
    expect(filesPassedToUpload?.[0]?.name).toBe('clip.mp4');
  });
});

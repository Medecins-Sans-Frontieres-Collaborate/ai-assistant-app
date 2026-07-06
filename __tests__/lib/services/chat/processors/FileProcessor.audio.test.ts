/**
 * Tests for the FileProcessor audio/video branch.
 *
 * The document branch is covered by FileProcessor.test.ts; this file covers
 * the A/V branch (FileProcessor.ts:226-474) which had zero coverage and was
 * the direct culprit of issue #90: an uploaded `.m4v` was never routed here
 * because the extension allowlist omitted it, so it fell through to the
 * document branch and surfaced a generic "unable to process the uploaded
 * file" error. After the allowlist fix (Part 1), `.m4v` now reaches this
 * branch and is transcribed via FFmpeg audio extraction → Whisper.
 *
 * Also locks the three user-facing error messages emitted by
 * StandardChatHandler when file processing fails, by asserting the exact
 * error message strings the FileProcessor re-throws.
 */
import { FileProcessingService } from '@/lib/services/chat/FileProcessingService';
import { FileProcessor } from '@/lib/services/chat/processors/FileProcessor';
import { InputValidator } from '@/lib/services/chat/validators/InputValidator';

import { loadDocument } from '@/lib/utils/server/file/fileHandling';

import { MessageType } from '@/types/chat';

import { createTestChatContext } from '../testUtils';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---------------------------------------------------------------

// Document-branch modules are imported by FileProcessor at module load but
// must never be reached from the A/V branch; mock them so they throw if called.
vi.mock('@/lib/utils/server/file/fileHandling', () => ({
  loadDocument: vi
    .fn()
    .mockRejectedValue(
      new Error('loadDocument should not be called for A/V files'),
    ),
}));

vi.mock('@/lib/utils/app/stream/documentSummary', () => ({
  estimateCharsPerToken: vi.fn(),
  calculateChunkConfig: vi.fn(),
  parseAndQueryFileOpenAI: vi.fn(),
}));

// FFmpeg availability + audio extraction. Programmable per test.
const extractorMocks = vi.hoisted(() => ({
  extractAudioFromVideo: vi.fn(),
  isFFmpegAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/lib/utils/server/audio/audioExtractor', () => extractorMocks);

// Magic-byte signature validation. Programmable per test (detectedType).
const validationMocks = vi.hoisted(() => ({
  validateBufferSignature: vi.fn(),
}));

vi.mock('@/lib/utils/server/file/fileValidation', () => validationMocks);

// Transcription service factory (Whisper sync path).
const whisperMocks = vi.hoisted(() => ({
  transcribe: vi.fn(),
}));

vi.mock('@/lib/services/transcriptionService', () => ({
  TranscriptionServiceFactory: {
    getTranscriptionService: vi.fn().mockReturnValue({
      transcribe: whisperMocks.transcribe,
    }),
    getServiceTypeForFileSize: vi.fn(),
  },
}));

// Chunked transcription service (>25MB path).
const chunkedMocks = vi.hoisted(() => ({
  startJob: vi.fn(),
  isAvailable: vi.fn().mockReturnValue(true),
}));

vi.mock('@/lib/services/transcription/chunkedTranscriptionService', () => ({
  getChunkedTranscriptionService: vi.fn().mockReturnValue({
    startJob: chunkedMocks.startJob,
    isAvailable: chunkedMocks.isAvailable,
  }),
}));

// Observability logger (fire-and-forget; must resolve).
vi.mock('@/lib/services/observability', () => ({
  getAzureMonitorLogger: vi.fn().mockReturnValue({
    logTranscriptionSuccess: vi.fn().mockResolvedValue(undefined),
    logTranscriptionQueued: vi.fn().mockResolvedValue(undefined),
    logTranscriptionError: vi.fn().mockResolvedValue(undefined),
    logFileError: vi.fn().mockResolvedValue(undefined),
  }),
}));

// Blob (image base64 conversion — not reached in A/V-only contexts, but
// imported by FileProcessor).
vi.mock('@/lib/utils/server/blob/blob', () => ({
  getBlobBase64String: vi.fn(),
}));

// fs: real fs.promises.stat is used by FileProcessor to get file sizes; mock
// it to return a controllable size. The download/read/cleanup use the
// FileProcessingService mock below.
const fsMocks = vi.hoisted(() => ({
  stat: vi.fn().mockResolvedValue({ size: 1024 * 1024 }),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        stat: fsMocks.stat,
      },
    },
  };
});

const mockLoadDocument = vi.mocked(loadDocument);

// --- Helpers --------------------------------------------------------------

function makeProcessor(fileBuffer: Buffer = Buffer.from('fake-audio')) {
  const mockFileService = {
    getTempFilePath: vi.fn((url: string) => {
      const id = url.split('/').pop();
      return [id, `/tmp/${id}`];
    }),
    getFileSize: vi.fn(async () => 1024 * 1024),
    downloadFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => fileBuffer),
    cleanupFile: vi.fn(async () => {}),
  };
  const mockValidator = { validateFileSize: vi.fn(async () => {}) };
  const processor = new FileProcessor(
    mockFileService as unknown as FileProcessingService,
    mockValidator as unknown as InputValidator,
  );
  return { processor, mockFileService };
}

function audioContext(filename: string, url?: string) {
  return createTestChatContext({
    hasFiles: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this' },
          {
            type: 'file_url',
            url: url ?? `https://blob.com/${filename}`,
            originalFilename: filename,
          },
        ],
        messageType: MessageType.FILE,
      },
    ],
  });
}

// --- Tests ----------------------------------------------------------------

describe('FileProcessor A/V branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractorMocks.isFFmpegAvailable.mockResolvedValue(true);
    fsMocks.stat.mockResolvedValue({ size: 1024 * 1024 });
    validationMocks.validateBufferSignature.mockReturnValue({
      isValid: true,
      detectedType: 'video',
      detectedFormat: 'mp4',
      expectedType: 'any',
      confidence: 'high',
    });
    mockLoadDocument.mockRejectedValue(
      new Error('loadDocument should not be called for A/V files'),
    );
  });

  describe('small (≤25MB) video → extract → Whisper', () => {
    it('extracts audio from an .m4v and sends the extracted mp3 to Whisper', async () => {
      const extractedPath = '/tmp/clip.m4v_audio.mp3';
      extractorMocks.extractAudioFromVideo.mockResolvedValue({
        outputPath: extractedPath,
      });
      whisperMocks.transcribe.mockResolvedValue('Hello world');
      // Original file small; extracted audio also small (≤25MB).
      fsMocks.stat.mockResolvedValue({
        size: 2 * 1024 * 1024,
      } as any);

      const { processor, mockFileService } = makeProcessor();
      const result = await processor.execute(audioContext('clip.m4v'));

      // Extraction was invoked (m4v is not Whisper-native).
      expect(extractorMocks.extractAudioFromVideo).toHaveBeenCalledWith(
        '/tmp/clip.m4v',
      );
      // Whisper received the extracted audio path, not the original video.
      expect(whisperMocks.transcribe).toHaveBeenCalledWith(
        extractedPath,
        expect.objectContaining({ language: undefined, prompt: undefined }),
      );
      // Transcript is surfaced.
      expect(result.processedContent?.transcripts).toEqual([
        { filename: 'clip.m4v', transcript: 'Hello world' },
      ]);
      // Extracted audio is cleaned up.
      expect(mockFileService.cleanupFile).toHaveBeenCalledWith(extractedPath);
    });

    it('sends a Whisper-native .mp3 directly to Whisper without extraction', async () => {
      // .mp3 is audio AND Whisper-native → no extraction needed.
      validationMocks.validateBufferSignature.mockReturnValue({
        isValid: true,
        detectedType: 'audio',
        detectedFormat: 'mp3',
        expectedType: 'any',
        confidence: 'high',
      });
      whisperMocks.transcribe.mockResolvedValue('native transcript');
      fsMocks.stat.mockResolvedValue({
        size: 1024 * 1024,
      } as any);

      const { processor } = makeProcessor();
      const result = await processor.execute(audioContext('song.mp3'));

      expect(extractorMocks.extractAudioFromVideo).not.toHaveBeenCalled();
      expect(whisperMocks.transcribe).toHaveBeenCalledWith(
        '/tmp/song.mp3',
        expect.any(Object),
      );
      expect(result.processedContent?.transcripts).toEqual([
        { filename: 'song.mp3', transcript: 'native transcript' },
      ]);
    });

    it('extracts audio from a non-Whisper-native audio file (.ogg)', async () => {
      // .ogg is audio but Whisper doesn't accept it — must be transcoded.
      validationMocks.validateBufferSignature.mockReturnValue({
        isValid: true,
        detectedType: 'audio',
        detectedFormat: 'ogg',
        expectedType: 'any',
        confidence: 'high',
      });
      const extractedPath = '/tmp/song.ogg_audio.mp3';
      extractorMocks.extractAudioFromVideo.mockResolvedValue({
        outputPath: extractedPath,
      });
      whisperMocks.transcribe.mockResolvedValue('ogg transcript');
      fsMocks.stat.mockResolvedValue({
        size: 1024 * 1024,
      } as any);

      const { processor } = makeProcessor();
      await processor.execute(audioContext('song.ogg'));

      expect(extractorMocks.extractAudioFromVideo).toHaveBeenCalledWith(
        '/tmp/song.ogg',
      );
      expect(whisperMocks.transcribe).toHaveBeenCalledWith(
        extractedPath,
        expect.any(Object),
      );
    });
  });

  describe('large (>25MB) video → extract → chunked', () => {
    it('routes a >25MB .m4v to the chunked transcription service', async () => {
      const extractedPath = '/tmp/clip.m4v_audio.mp3';
      extractorMocks.extractAudioFromVideo.mockResolvedValue({
        outputPath: extractedPath,
      });
      chunkedMocks.startJob.mockResolvedValue({
        jobId: 'job-123',
        totalChunks: 4,
      });
      // FileProcessor calls fs.promises.stat three times in the extract path:
      // (1) original video, (2) extracted audio for logging, (3) extracted
      // audio for routing. The routing call (#3) determines Whisper vs chunked.
      fsMocks.stat
        .mockResolvedValueOnce({ size: 50 * 1024 * 1024 } as any) // (1) original video
        .mockResolvedValue({ size: 30 * 1024 * 1024 } as any); // (2)(3) extracted audio >25MB → chunked

      const { processor } = makeProcessor();
      const result = await processor.execute(audioContext('clip.m4v'));

      expect(extractorMocks.extractAudioFromVideo).toHaveBeenCalledWith(
        '/tmp/clip.m4v',
      );
      expect(chunkedMocks.startJob).toHaveBeenCalledWith(
        extractedPath,
        'clip.m4v',
        'test-user-123',
        expect.objectContaining({ language: undefined, prompt: undefined }),
      );
      // Pending transcription is surfaced for client-side polling.
      expect(result.processedContent?.pendingTranscriptions).toEqual([
        {
          filename: 'clip.m4v',
          jobId: 'job-123',
          totalChunks: 4,
          jobType: 'chunked',
        },
      ]);
      // Placeholder transcript present for UI display.
      expect(result.processedContent?.transcripts).toEqual([
        {
          filename: 'clip.m4v',
          transcript: '[Transcription in progress: clip.m4v]',
        },
      ]);
    });

    // Size GROWTH across transcoding: extraction is a fixed 128kbps mp3, so a
    // small high-compression source (a long opus/ogg voice memo well under
    // 25MB) can inflate PAST the Whisper cap. Routing must key off the
    // post-extraction size, not the original — otherwise Whisper rejects the
    // oversized payload with a 413.
    it('routes a ≤25MB source whose EXTRACTED audio exceeds 25MB to chunked', async () => {
      const extractedPath = '/tmp/memo.opus_audio.mp3';
      extractorMocks.extractAudioFromVideo.mockResolvedValue({
        outputPath: extractedPath,
      });
      chunkedMocks.startJob.mockResolvedValue({
        jobId: 'job-456',
        totalChunks: 5,
      });
      // Audio (not video) content — extraction still required because opus
      // is not Whisper-native.
      validationMocks.validateBufferSignature.mockReturnValue({
        isValid: true,
        detectedType: 'audio',
        detectedFormat: 'ogg',
        expectedType: 'any',
        confidence: 'high',
      });
      fsMocks.stat
        .mockResolvedValueOnce({ size: 20 * 1024 * 1024 } as any) // (1) original: under the cap
        .mockResolvedValue({ size: 110 * 1024 * 1024 } as any); // (2)(3) extracted mp3: way over

      const { processor } = makeProcessor();
      const result = await processor.execute(audioContext('memo.opus'));

      expect(extractorMocks.extractAudioFromVideo).toHaveBeenCalledWith(
        '/tmp/memo.opus',
      );
      // Must NOT go to Whisper — the extracted mp3 is over the cap.
      expect(whisperMocks.transcribe).not.toHaveBeenCalled();
      expect(chunkedMocks.startJob).toHaveBeenCalledWith(
        extractedPath,
        'memo.opus',
        'test-user-123',
        expect.anything(),
      );
      expect(result.processedContent?.pendingTranscriptions).toEqual([
        expect.objectContaining({ jobId: 'job-456', jobType: 'chunked' }),
      ]);
    });
  });

  describe('error mapping (StandardChatHandler contract)', () => {
    // These tests lock the exact error message strings that
    // StandardChatHandler.ts:210-222 pattern-matches to render its three
    // user-facing messages. Changing the wording here without updating
    // StandardChatHandler would silently regress the UX.

    it('surfaces "does not contain an audio track" verbatim from the extractor', async () => {
      extractorMocks.extractAudioFromVideo.mockRejectedValue(
        new Error(
          'The video file does not contain an audio track. Cannot extract audio from a video-only file.',
        ),
      );
      fsMocks.stat.mockResolvedValue({
        size: 1024 * 1024,
      } as any);

      const { processor } = makeProcessor();
      const result = await processor.execute(audioContext('silent.m4v'));

      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.errors![0].message).toContain(
        'does not contain an audio track',
      );
    });

    it('surfaces "FFmpeg is not available" when ffmpeg is missing', async () => {
      extractorMocks.isFFmpegAvailable.mockResolvedValue(false);
      fsMocks.stat.mockResolvedValue({
        size: 1024 * 1024,
      } as any);

      const { processor } = makeProcessor();
      const result = await processor.execute(audioContext('clip.m4v'));

      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.errors![0].message).toContain('FFmpeg is not available');
      // Extraction must not be attempted when ffmpeg isn't available.
      expect(extractorMocks.extractAudioFromVideo).not.toHaveBeenCalled();
    });

    it('wraps unknown extraction failures with "Audio extraction failed"', async () => {
      extractorMocks.extractAudioFromVideo.mockRejectedValue(
        new Error('Unsupported codec: amr'),
      );
      fsMocks.stat.mockResolvedValue({
        size: 1024 * 1024,
      } as any);

      const { processor } = makeProcessor();
      const result = await processor.execute(audioContext('weird.m4v'));

      expect(result.errors?.length).toBeGreaterThan(0);
      const message = result.errors![0].message;
      // StandardChatHandler's generic branch matches on "Audio extraction".
      expect(message).toContain('Audio extraction failed');
      expect(message).toContain('Cannot transcribe video file');
      // Note: the original extractor error context is intentionally NOT
      // preserved — the FileProcessor replaces it with a generic message.
      // If this changes, surface it deliberately (StandardChatHandler relies
      // on the "Audio extraction" substring for its generic-error branch).
    });

    it('throws "FFmpeg is not available" for a video when isFFmpegAvailable is false', async () => {
      extractorMocks.isFFmpegAvailable.mockResolvedValue(false);
      fsMocks.stat.mockResolvedValue({
        size: 1024 * 1024,
      } as any);

      const { processor } = makeProcessor();
      const result = await processor.execute(
        audioContext('clip.mov', 'https://blob.com/clip.mov'),
      );

      expect(result.errors?.length).toBeGreaterThan(0);
      expect(result.errors![0].message).toContain('FFmpeg is not available');
    });
  });

  describe('extracted-audio cleanup', () => {
    it('cleans up extracted audio even when Whisper throws', async () => {
      const extractedPath = '/tmp/clip.m4v_audio.mp3';
      extractorMocks.extractAudioFromVideo.mockResolvedValue({
        outputPath: extractedPath,
      });
      whisperMocks.transcribe.mockRejectedValue(new Error('Whisper down'));
      fsMocks.stat.mockResolvedValue({
        size: 1024 * 1024,
      } as any);

      const { processor, mockFileService } = makeProcessor();
      await processor.execute(audioContext('clip.m4v'));

      // The extracted audio temp file must be reclaimed even on failure.
      expect(mockFileService.cleanupFile).toHaveBeenCalledWith(extractedPath);
    });
  });
});

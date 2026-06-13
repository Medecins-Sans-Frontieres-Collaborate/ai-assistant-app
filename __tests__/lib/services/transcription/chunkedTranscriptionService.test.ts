import { ChunkedTranscriptionService } from '@/lib/services/transcription/chunkedTranscriptionService';

import { TranscriptionError } from '@/types/transcription';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Programmable per-test Whisper behavior, shared by every constructed
// service instance (the retry loop may rebuild the client mid-job).
const whisperMocks = vi.hoisted(() => ({
  transcribeChunk: vi.fn<(path: string) => Promise<string>>(),
}));

// Stub the Whisper client so instantiation doesn't require Azure env vars.
vi.mock('@/lib/services/transcription/whisperTranscriptionService', () => ({
  WhisperTranscriptionService: vi.fn().mockImplementation(function (this: {
    transcribeChunk: typeof whisperMocks.transcribeChunk;
  }) {
    this.transcribeChunk = whisperMocks.transcribeChunk;
  }),
}));

const storeMocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  createJob: vi.fn(),
  updateProgress: vi.fn(),
  completeJob: vi.fn(),
  failJob: vi.fn(),
}));

vi.mock('@/lib/services/transcription/chunkedJobStore', () => storeMocks);

const splitterMocks = vi.hoisted(() => ({
  cleanupChunks: vi.fn().mockResolvedValue(undefined),
  isAudioSplittingAvailable: vi.fn().mockReturnValue(true),
  splitAudioFile: vi.fn(),
}));

vi.mock('@/lib/utils/server/audio/audioSplitter', () => splitterMocks);

// `combineTranscripts` and `processChunksAsync` are private; tests reach
// them via a typed escape hatch (same pattern used elsewhere in the suite).
type PrivateAccess = {
  combineTranscripts: (transcripts: string[], total: number) => string;
  processChunksAsync: (
    jobId: string,
    chunkPaths: string[],
    filename: string,
  ) => Promise<void>;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function permanentError(message: string): TranscriptionError {
  const err = new Error(message) as TranscriptionError;
  err.errorClass = 'permanent';
  return err;
}

describe('ChunkedTranscriptionService.combineTranscripts', () => {
  const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;

  it('returns the single transcript verbatim for a one-chunk job', () => {
    expect(svc.combineTranscripts(['hello world'], 1)).toBe('hello world');
  });

  it('adds chunk markers for multi-chunk jobs', () => {
    const combined = svc.combineTranscripts(['a', 'b'], 2);
    expect(combined).toBe('[Chunk 1/2]\na\n\n[Chunk 2/2]\nb');
  });

  it('marks empty chunks as "no speech detected" so the transcript is not silent', () => {
    const combined = svc.combineTranscripts(['hello', '', 'world'], 3);
    expect(combined).toContain(
      '[Chunk 2/3]\n(no speech detected in this segment)',
    );
    expect(combined).toContain('[Chunk 1/3]\nhello');
    expect(combined).toContain('[Chunk 3/3]\nworld');
  });
});

describe('ChunkedTranscriptionService.processChunksAsync (worker pool)', () => {
  const jobId = '11111111-2222-3333-4444-555555555555';
  const chunkPaths = ['/c/0.mp3', '/c/1.mp3', '/c/2.mp3', '/c/3.mp3'];

  beforeEach(() => {
    vi.clearAllMocks();
    splitterMocks.cleanupChunks.mockResolvedValue(undefined);
    storeMocks.getJob.mockReturnValue({ jobId, status: 'processing' });
  });

  it('completes with chunks in playback order even when they finish out of order', async () => {
    // Later chunks finish first — the pool must reorder by index.
    const delays = [40, 25, 10, 5];
    whisperMocks.transcribeChunk.mockImplementation(async (path: string) => {
      const index = chunkPaths.indexOf(path);
      await delay(delays[index]);
      return `t${index}`;
    });

    const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;
    await svc.processChunksAsync(jobId, chunkPaths, 'file.mp3');

    expect(storeMocks.completeJob).toHaveBeenCalledTimes(1);
    const transcript = storeMocks.completeJob.mock.calls[0][1] as string;
    expect(transcript).toBe(
      '[Chunk 1/4]\nt0\n\n[Chunk 2/4]\nt1\n\n[Chunk 3/4]\nt2\n\n[Chunk 4/4]\nt3',
    );
    expect(storeMocks.failJob).not.toHaveBeenCalled();
    expect(splitterMocks.cleanupChunks).toHaveBeenCalledWith(chunkPaths);
  });

  it('starts no chunks when the job is already cancelled', async () => {
    storeMocks.getJob.mockReturnValue({ jobId, status: 'cancelled' });

    const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;
    await svc.processChunksAsync(jobId, chunkPaths, 'file.mp3');

    expect(whisperMocks.transcribeChunk).not.toHaveBeenCalled();
    expect(storeMocks.completeJob).not.toHaveBeenCalled();
    expect(storeMocks.failJob).not.toHaveBeenCalled();
    // Chunks are still reclaimed.
    expect(splitterMocks.cleanupChunks).toHaveBeenCalledWith(chunkPaths);
  });

  it('a permanent chunk failure fails the job and stops idle workers from claiming more chunks', async () => {
    whisperMocks.transcribeChunk.mockImplementation(async (path: string) => {
      const index = chunkPaths.indexOf(path);
      if (index === 0) {
        throw permanentError('chunk too large');
      }
      await delay(30);
      return `t${index}`;
    });

    const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;
    await expect(
      svc.processChunksAsync(jobId, chunkPaths, 'file.mp3'),
    ).rejects.toThrow('chunk too large');

    expect(storeMocks.failJob).toHaveBeenCalledWith(
      jobId,
      'chunk too large',
      'permanent',
    );
    expect(storeMocks.completeJob).not.toHaveBeenCalled();
    // Default concurrency is 3: chunks 0–2 were claimed before the failure,
    // but chunk 3 must never start once the abort flag is set.
    expect(whisperMocks.transcribeChunk).toHaveBeenCalledTimes(3);
    expect(splitterMocks.cleanupChunks).toHaveBeenCalledWith(chunkPaths);
  });

  it('a cancel mid-run stops remaining chunks without marking the job failed', async () => {
    let completedFirst = false;
    storeMocks.getJob.mockImplementation(() => ({
      jobId,
      // Cancelled as soon as the first chunk has gone through.
      status: completedFirst ? 'cancelled' : 'processing',
    }));
    whisperMocks.transcribeChunk.mockImplementation(async (path: string) => {
      await delay(10);
      completedFirst = true;
      return `t${chunkPaths.indexOf(path)}`;
    });

    const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;
    await svc.processChunksAsync(jobId, chunkPaths, 'file.mp3');

    expect(storeMocks.completeJob).not.toHaveBeenCalled();
    expect(storeMocks.failJob).not.toHaveBeenCalled();
    // The first wave (3 workers) ran; nothing was claimed after the cancel.
    expect(whisperMocks.transcribeChunk.mock.calls.length).toBeLessThanOrEqual(
      3,
    );
    expect(splitterMocks.cleanupChunks).toHaveBeenCalledWith(chunkPaths);
  });
});

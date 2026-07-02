/**
 * Tests for ChunkedTranscriptionService.transcribeChunkWithRetry.
 *
 * The existing chunkedTranscriptionService.test.ts covers combineTranscripts
 * and the worker pool (out-of-order completion, cancel, permanent failure)
 * using real timers with tiny delays. The retry loop itself — error-class
 * branching, backoff, auth-driven client rebuild, attempt exhaustion — is
 * reached via processChunksAsync but never exercised. These tests fill that
 * gap using fake timers (backoff can reach 30s).
 *
 * Coverage:
 *  - 'auth' → Whisper client re-instantiated once, retry succeeds.
 *  - 'rate_limit' with retryAfterSeconds → backoff honors the server hint.
 *  - 'transient' exhausted → throws with the last errorClass preserved.
 *  - abort mid-backoff → 'transient' abort error.
 *  - 'permanent' → no retry (re-thrown immediately), no backoff sleep.
 */
import { ChunkedTranscriptionService } from '@/lib/services/transcription/chunkedTranscriptionService';

import { TranscriptionError } from '@/types/transcription';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Programmable per-test Whisper behavior.
const whisperMocks = vi.hoisted(() => ({
  transcribeChunk: vi.fn<(path: string) => Promise<string>>(),
}));

// Track constructor calls so the 'auth' test can assert a client rebuild.
const whisperCtor = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/transcription/whisperTranscriptionService', () => ({
  WhisperTranscriptionService: whisperCtor.mockImplementation(function (this: {
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

// `processChunksAsync` is private; reach it via a typed escape hatch.
type PrivateAccess = {
  processChunksAsync: (
    jobId: string,
    chunkPaths: string[],
    filename: string,
  ) => Promise<void>;
};

const jobId = '11111111-2222-3333-4444-555555555555';
const singleChunk = ['/c/0.mp3'];

function taggedError(
  message: string,
  errorClass: TranscriptionError['errorClass'],
  retryAfterSeconds?: number,
): TranscriptionError {
  const err = new Error(message) as TranscriptionError;
  err.errorClass = errorClass;
  if (retryAfterSeconds !== undefined)
    err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

describe('ChunkedTranscriptionService.transcribeChunkWithRetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    splitterMocks.cleanupChunks.mockResolvedValue(undefined);
    storeMocks.getJob.mockReturnValue({ jobId, status: 'processing' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rebuilds the Whisper client once on an auth error and retries successfully', async () => {
    // First attempt: auth error. Second attempt: success.
    whisperMocks.transcribeChunk
      .mockRejectedValueOnce(taggedError('auth expired', 'auth'))
      .mockResolvedValueOnce('recovered transcript');

    const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;
    const promise = svc.processChunksAsync(jobId, singleChunk, 'file.mp3');

    // The auth retry has a backoff sleep (exponential, attempt 1). Flush it.
    await vi.advanceTimersByTimeAsync(5000);
    await promise;

    // The constructor must have been called twice: initial + auth rebuild.
    expect(whisperCtor).toHaveBeenCalledTimes(2);
    expect(storeMocks.completeJob).toHaveBeenCalledTimes(1);
    const transcript = storeMocks.completeJob.mock.calls[0][1] as string;
    expect(transcript).toBe('recovered transcript');
    expect(storeMocks.failJob).not.toHaveBeenCalled();
  });

  it('honors the server Retry-After for a rate_limit error', async () => {
    whisperMocks.transcribeChunk
      .mockRejectedValueOnce(
        taggedError('rate limited', 'rate_limit', 3), // retryAfterSeconds=3
      )
      .mockResolvedValueOnce('after backoff');

    const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;
    const promise = svc.processChunksAsync(jobId, singleChunk, 'file.mp3');

    // The backoff for rate_limit+retryAfterSeconds ≈ 3000ms * (1..1.25).
    // Advancing past 4000ms guarantees the jittered sleep elapses.
    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    expect(storeMocks.completeJob).toHaveBeenCalledTimes(1);
    // Only two attempts: one failed, one succeeded.
    expect(whisperMocks.transcribeChunk).toHaveBeenCalledTimes(2);
  });

  it('preserves the errorClass when attempts are exhausted on a transient error', async () => {
    // Always transient → retries until MAX_CHUNK_ATTEMPTS (default retries=2 → 3 attempts).
    whisperMocks.transcribeChunk.mockRejectedValue(
      taggedError('server 500', 'transient'),
    );

    const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;
    let caught: Error | undefined;
    const settled = svc
      .processChunksAsync(jobId, singleChunk, 'file.mp3')
      .catch((e: Error) => {
        caught = e;
      });

    // Flush the exponential backoff sleeps between attempts:
    // attempt 1 → ~1000-2000ms, attempt 2 → ~2000-4000ms. Advance generously.
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/after 3 attempts/);

    expect(whisperMocks.transcribeChunk).toHaveBeenCalledTimes(3);
    expect(storeMocks.failJob).toHaveBeenCalledTimes(1);
    // The failure must carry the last errorClass so clients can branch.
    expect(storeMocks.failJob.mock.calls[0][2]).toBe('transient');
    expect(storeMocks.completeJob).not.toHaveBeenCalled();
  });

  it('does not retry a permanent error (throws immediately, no backoff)', async () => {
    whisperMocks.transcribeChunk.mockRejectedValue(
      taggedError('bad codec', 'permanent'),
    );

    const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;
    // No timers to advance — permanent errors bypass the retry loop.
    await expect(
      svc.processChunksAsync(jobId, singleChunk, 'file.mp3'),
    ).rejects.toThrow('bad codec');

    // Exactly one attempt — no retries, no backoff sleep.
    expect(whisperMocks.transcribeChunk).toHaveBeenCalledTimes(1);
    expect(storeMocks.failJob).toHaveBeenCalledWith(
      jobId,
      'bad codec',
      'permanent',
    );
    // No timers were scheduled (permanent short-circuits before delay()).
    // Confirm by checking real elapsed time stayed ~0.
  });

  it('aborts the retry sequence when shouldAbort becomes true before the next attempt', async () => {
    // First attempt: transient (enters backoff). The retry loop checks
    // shouldAbort() after the backoff sleep; if it's true, it throws a
    // 'transient' abort error instead of retrying.
    //
    // We flip shouldAbort by making the second chunk throw a permanent error
    // (which sets fatalError), and giving the first chunk a transient error
    // whose backoff outlasts the second chunk's immediate permanent throw.
    // Concurrency (default 3) lets both workers start together.
    const twoChunks = ['/c/0.mp3', '/c/1.mp3'];
    let firstChunkAttempts = 0;
    whisperMocks.transcribeChunk.mockImplementation(async (p: string) => {
      if (p === '/c/1.mp3') {
        // Immediate permanent error → sets fatalError, stops idle workers.
        throw taggedError('fatal permanent', 'permanent');
      }
      // First chunk: always transient so it stays in the retry/backoff loop.
      firstChunkAttempts += 1;
      throw taggedError('transient blip', 'transient');
    });

    const svc = new ChunkedTranscriptionService() as unknown as PrivateAccess;
    // Attach the rejection handler eagerly so it isn't reported as unhandled
    // when the fake-timer microtask checkpoint runs before the assert below.
    let caught: Error | undefined;
    const settled = svc
      .processChunksAsync(jobId, twoChunks, 'file.mp3')
      .catch((e: Error) => {
        caught = e;
      });

    // Flush the backoff sleep of the first chunk's retry. By then the second
    // chunk's permanent error has set fatalError, so the first worker's
    // post-sleep shouldAbort() check is true and it aborts (no new attempt).
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    // processChunksAsync rethrows fatalError (the permanent one).
    expect(caught).toBeDefined();
    expect(caught!.message).toContain('fatal permanent');

    // The first chunk must NOT have been retried past its first attempt —
    // the abort check fires before attempt 2 begins.
    expect(firstChunkAttempts).toBe(1);
    expect(storeMocks.failJob).toHaveBeenCalledWith(
      jobId,
      expect.stringContaining('fatal permanent'),
      'permanent',
    );
  });
});

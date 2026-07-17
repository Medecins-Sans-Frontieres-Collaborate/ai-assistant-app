/**
 * Tests for WhisperTranscriptionService HTTP-error classification.
 *
 * transcribeSegment maps OpenAI/Azure HTTP errors to TranscriptionErrorClass
 * so the chunked retry loop can branch correctly:
 *  - 429 / rate_limit_exceeded → 'rate_limit' (+ Retry-After parsing)
 *  - 401 / 403                  → 'auth'
 *  - 5xx                        → 'transient'
 *  - other 4xx                  → 'permanent'
 *  - no status (network)        → 'transient'
 *
 * extractRetryAfterSeconds is private; it's exercised here through the
 * rate_limit path (header + message-regex fallback, boundary clamping).
 *
 * Regression for issue #90: a Whisper 4xx on a raw .m4v (sent without audio
 * extraction by the legacy route) was previously unclassified ('unknown'),
 * so the chunked loop retried a permanent rejection. Now it must be 'permanent'.
 */
import { WhisperTranscriptionService } from '@/lib/services/transcription/whisperTranscriptionService';

import { TranscriptionError } from '@/types/transcription';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Stub env so the constructor doesn't require real Azure configuration.
vi.mock('@/config/environment', () => ({
  env: {
    OPENAI_API_KEY: 'test-key',
    AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com',
    OPENAI_API_VERSION: '2024-06-01',
  },
}));

// Programmable AzureOpenAI.audio.transcriptions.create. Hoisted so the mock
// factory (which runs before imports) can reference it.
const createMock = vi.hoisted(() => vi.fn());

// Mock the OpenAI SDK client. The service constructs `new AzureOpenAI(...)`
// and then calls `client.audio.transcriptions.create(...)`. Use a regular
// function (not an arrow) so `new AzureOpenAI(...)` works.
vi.mock('openai', () => ({
  AzureOpenAI: vi.fn().mockImplementation(function (this: any) {
    this.audio = {
      transcriptions: {
        create: createMock,
      },
    };
  }),
}));

// Mock fs.createReadStream so the service doesn't actually open the temp
// file. The mocked AzureOpenAI.create rejects before consuming the stream,
// but the ReadStream object still tries to open the file asynchronously —
// which races with afterAll's workDir cleanup and surfaces an unhandled
// ENOENT. Returning a stub object (never read) avoids the real open().
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      createReadStream: vi.fn(() => ({}) as any),
    },
  };
});

// Avoid pulling in @azure/identity (DefaultAzureCredential) — the env stub
// above sets OPENAI_API_KEY so the API-key branch is taken, but the import
// still resolves; mock it to keep the test hermetic.
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: vi.fn(),
  getBearerTokenProvider: vi.fn(),
}));

function makeApiError(
  overrides: {
    status?: number;
    code?: string;
    message?: string;
    headers?: Record<string, string>;
  } = {},
): Error {
  const err = new Error(overrides.message ?? 'API error') as Error & {
    status?: number;
    code?: string;
    headers?: Record<string, string>;
  };
  err.status = overrides.status;
  err.code = overrides.code;
  err.headers = overrides.headers;
  return err;
}

describe('WhisperTranscriptionService error classification', () => {
  let workDir: string;
  let smallFile: string;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'whisper-error-class-test-'),
    );
    smallFile = path.join(workDir, 'small.mp3');
    // A real (empty) file under the 25MB limit so transcribe() reaches
    // transcribeSegment instead of failing the size check.
    await fs.promises.writeFile(smallFile, Buffer.alloc(1024, 0));
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function transcribe(): Promise<TranscriptionError> {
    const service = new WhisperTranscriptionService();
    try {
      await service.transcribe(smallFile);
    } catch (error) {
      return error as TranscriptionError;
    }
    throw new Error('expected transcribe() to reject');
  }

  it('classifies 429 as rate_limit and parses Retry-After header (seconds)', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({
        status: 429,
        code: 'rate_limit_exceeded',
        headers: { 'retry-after': '5' },
      }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('rate_limit');
    expect(err.retryAfterSeconds).toBe(5);
    expect(err.message).toContain('wait 5 seconds');
  });

  it('falls back to the message regex when no Retry-After header is present', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'Please retry after 12 seconds.',
      }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('rate_limit');
    expect(err.retryAfterSeconds).toBe(12);
  });

  it('returns undefined retryAfterSeconds for out-of-range values (>600)', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({
        status: 429,
        code: 'rate_limit_exceeded',
        headers: { 'retry-after': '601' },
      }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('rate_limit');
    // 601 is out of the [1, 600] clamp → no retryAfterSeconds.
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it('returns undefined retryAfterSeconds for a zero Retry-After', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({
        status: 429,
        code: 'rate_limit_exceeded',
        headers: { 'retry-after': '0' },
      }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('rate_limit');
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it('prefers the Retry-After header over the message regex', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'Please retry after 99 seconds.',
        headers: { 'retry-after': '3' },
      }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('rate_limit');
    expect(err.retryAfterSeconds).toBe(3); // header wins
  });

  it('classifies 401 as auth', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({ status: 401, message: 'Invalid API key' }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('auth');
    expect(err.message).toContain('auth failed');
  });

  it('classifies 403 as auth', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({ status: 403, message: 'Forbidden' }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('auth');
  });

  it('classifies 500 as transient', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({ status: 500, message: 'Internal server error' }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('transient');
    expect(err.message).toContain('service error');
  });

  it('classifies 503 as transient', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({ status: 503, message: 'Service unavailable' }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('transient');
  });

  it('classifies 400 as permanent (e.g. Whisper rejecting an unsupported format)', async () => {
    // This is the failure mode the legacy /api/file/[id]/transcribe route hit
    // for .m4v before the extraction fix: Whisper rejects the container with
    // a 4xx. The chunked loop must NOT retry it.
    createMock.mockRejectedValueOnce(
      makeApiError({ status: 400, message: 'Invalid file format' }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('permanent');
    expect(err.message).toContain('rejected');
  });

  it('classifies 404 as permanent (4xx, not retried)', async () => {
    createMock.mockRejectedValueOnce(
      makeApiError({ status: 404, message: 'Deployment not found' }),
    );

    const err = await transcribe();

    expect(err.errorClass).toBe('permanent');
  });

  it('classifies no-status network errors as transient', async () => {
    // ECONNRESET etc. have no HTTP status — the catch branch with `!status`
    // treats them as transient (retryable).
    const networkErr = new Error('socket hang up') as Error & {
      code?: string;
    };
    networkErr.code = 'ECONNRESET';
    createMock.mockRejectedValueOnce(networkErr);

    const err = await transcribe();

    expect(err.errorClass).toBe('transient');
  });
});

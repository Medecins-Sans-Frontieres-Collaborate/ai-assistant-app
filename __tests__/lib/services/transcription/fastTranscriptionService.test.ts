/**
 * Tests for the Azure AI Speech fast transcription service: locale mapping,
 * request shape (raw speech, no profanity masking), and error classification
 * consistent with the Whisper service's retry semantics.
 */
import {
  FAST_TRANSCRIPTION_MAX_SIZE,
  FastTranscriptionService,
} from '@/lib/services/transcription/fastTranscriptionService';

import { TranscriptionError } from '@/types/transcription';

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('@/config/environment', () => ({
  env: {
    AZURE_SPEECH_KEY: 'test-speech-key',
    AZURE_SPEECH_REGION: 'westeurope',
  },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('FastTranscriptionService', () => {
  let workDir: string;
  let smallPath: string;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'fast-transcription-test-'),
    );
    smallPath = path.join(workDir, 'small.wav');
    await fs.promises.writeFile(smallPath, 'synthetic test fixture');
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('sends the mapped locale with profanity filtering off and joins phrases', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        combinedPhrases: [{ text: 'Waa maxay' }, { text: 'warkii maanta?' }],
      }),
    );
    const service = new FastTranscriptionService();
    const transcript = await service.transcribe(smallPath, { language: 'so' });
    expect(transcript).toBe('Waa maxay\nwarkii maanta?');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://westeurope.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15',
    );
    expect(init.headers['Ocp-Apim-Subscription-Key']).toBe('test-speech-key');
    const definition = JSON.parse(init.body.get('definition'));
    expect(definition).toEqual({
      locales: ['so-SO'],
      profanityFilterMode: 'None',
    });
  });

  it('rejects unmapped languages without calling the API', async () => {
    const service = new FastTranscriptionService();
    await expect(
      service.transcribe(smallPath, { language: 'ht' }),
    ).rejects.toMatchObject({ errorClass: 'permanent' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('classifies HTTP failures like the Whisper service', async () => {
    const service = new FastTranscriptionService();
    const cases: Array<[number, TranscriptionError['errorClass']]> = [
      [400, 'permanent'],
      [401, 'auth'],
      [403, 'auth'],
      [503, 'transient'],
    ];
    for (const [status, errorClass] of cases) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(status, { error: { message: 'nope' } }),
      );
      await expect(
        service.transcribe(smallPath, { language: 'so' }),
      ).rejects.toMatchObject({ errorClass });
    }
  });

  it('extracts Retry-After from rate-limit responses', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, {}, { 'retry-after': '17' }),
    );
    const service = new FastTranscriptionService();
    await expect(
      service.transcribe(smallPath, { language: 'so' }),
    ).rejects.toMatchObject({
      errorClass: 'rate_limit',
      retryAfterSeconds: 17,
    });
  });

  it('tags network failures as transient', async () => {
    fetchMock.mockRejectedValueOnce(new Error('socket hang up'));
    const service = new FastTranscriptionService();
    await expect(
      service.transcribe(smallPath, { language: 'so' }),
    ).rejects.toMatchObject({ errorClass: 'transient' });
  });

  it('rejects oversized files with a permanent errorClass', async () => {
    const oversizedPath = path.join(workDir, 'oversized.wav');
    const handle = await fs.promises.open(oversizedPath, 'w');
    await handle.truncate(FAST_TRANSCRIPTION_MAX_SIZE + 1);
    await handle.close();
    const service = new FastTranscriptionService();
    await expect(
      service.transcribe(oversizedPath, { language: 'so' }),
    ).rejects.toMatchObject({ errorClass: 'permanent' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

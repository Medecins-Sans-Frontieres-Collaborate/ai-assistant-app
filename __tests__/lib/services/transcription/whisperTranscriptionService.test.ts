/**
 * Tests for WhisperTranscriptionService size-limit handling.
 *
 * Regression for issue #57: oversized inputs were thrown as untagged Errors
 * (errorClass 'unknown'), so chunkedTranscriptionService retried them 3x even
 * though a file never shrinks between attempts. They must be 'permanent'.
 */
import { WhisperTranscriptionService } from '@/lib/services/transcription/whisperTranscriptionService';

import { WHISPER_MAX_SIZE } from '@/lib/utils/app/const';

import { TranscriptionError } from '@/types/transcription';

import {
  getOfficialTranscriptionLanguages,
  getTranscriptionLanguageByCode,
  getUnofficialTranscriptionLanguages,
} from '@/lib/constants/transcriptionLanguages';
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

const createTranscription = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  AzureOpenAI: vi.fn().mockImplementation(function () {
    return { audio: { transcriptions: { create: createTranscription } } };
  }),
}));

describe('WhisperTranscriptionService size limit', () => {
  let workDir: string;
  let oversizedPath: string;
  let smallPath: string;

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-size-test-'));
    oversizedPath = path.join(workDir, 'oversized.mp3');
    smallPath = path.join(workDir, 'small.wav');
    await fs.promises.writeFile(smallPath, 'synthetic test fixture');
    // Sparse file just over the limit — instant to create, no real disk use.
    const handle = await fs.promises.open(oversizedPath, 'w');
    await handle.truncate(WHISPER_MAX_SIZE + 1);
    await handle.close();
  });

  it.each(
    getOfficialTranscriptionLanguages()
      .filter((l) => l.code)
      .map((l) => l.code),
  )('sends official hint %s unchanged to Azure', async (language) => {
    createTranscription.mockImplementation(async ({ file }) => {
      file.destroy();
      return { text: 'spoken content' };
    });
    const service = new WhisperTranscriptionService();
    expect(await service.transcribe(smallPath, { language })).toBe(
      'spoken content',
    );
    expect(createTranscription).toHaveBeenLastCalledWith(
      expect.objectContaining({ language, temperature: 0 }),
    );
  });

  // Azure rejects every experimental hint with HTTP 400 unsupported_language
  // (acceptance probe 2026-10-15), so these become the disclosed auto-detect
  // fallback: no language parameter, autonym as the decoding cue.
  it.each(getUnofficialTranscriptionLanguages().map((l) => l.code))(
    'converts experimental hint %s to auto-detect with a native-language cue',
    async (language) => {
      createTranscription.mockClear();
      createTranscription.mockImplementation(async ({ file }) => {
        file.destroy();
        return { text: 'spoken content' };
      });
      const service = new WhisperTranscriptionService();
      expect(await service.transcribe(smallPath, { language })).toBe(
        'spoken content',
      );
      // Exactly one request: a proactive fallback, not a rejected-then-retried hint.
      expect(createTranscription).toHaveBeenCalledTimes(1);
      expect(createTranscription).toHaveBeenLastCalledWith(
        expect.objectContaining({
          language: undefined,
          prompt: getTranscriptionLanguageByCode(language)?.autonym,
          temperature: 0,
        }),
      );
    },
  );

  it('keeps the user prompt over the autonym cue on fallback', async () => {
    createTranscription.mockClear();
    createTranscription.mockImplementation(async ({ file }) => {
      file.destroy();
      return { text: 'spoken content' };
    });
    const service = new WhisperTranscriptionService();
    await service.transcribe(smallPath, {
      language: 'so',
      prompt: 'Caafimaadka iyo dawooyinka',
    });
    expect(createTranscription).toHaveBeenLastCalledWith(
      expect.objectContaining({
        language: undefined,
        prompt: 'Caafimaadka iyo dawooyinka',
      }),
    );
  });

  it('passes unknown codes through unchanged (regional compatibility)', async () => {
    createTranscription.mockClear();
    createTranscription.mockImplementation(async ({ file }) => {
      file.destroy();
      return { text: 'spoken content' };
    });
    const service = new WhisperTranscriptionService();
    await service.transcribe(smallPath, { language: 'pt-br' });
    expect(createTranscription).toHaveBeenLastCalledWith(
      expect.objectContaining({ language: 'pt-br' }),
    );
  });

  it('does not silently retry with auto-detect after a language rejection', async () => {
    createTranscription.mockClear();
    createTranscription.mockImplementationOnce(async ({ file }) => {
      file.destroy();
      throw { status: 400, message: 'Invalid language' };
    });
    const service = new WhisperTranscriptionService();
    await expect(
      service.transcribe(smallPath, { language: 'fr' }),
    ).rejects.toMatchObject({ errorClass: 'permanent' });
    expect(createTranscription).toHaveBeenCalledTimes(1);
    expect(createTranscription).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'fr' }),
    );
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('rejects oversized files with a permanent errorClass (no futile retries)', async () => {
    const service = new WhisperTranscriptionService();

    let thrown: TranscriptionError | undefined;
    try {
      await service.transcribe(oversizedPath);
    } catch (error) {
      thrown = error as TranscriptionError;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.errorClass).toBe('permanent');
    expect(thrown!.message).toContain('exceeds the maximum limit');
  });

  // transcribeChunk is the chunked pipeline's entry point. Its size check
  // carries chunk-appropriate wording — the user uploaded a whole recording,
  // not this chunk, so transcribe()'s "please upload a shorter audio file"
  // message would mislead.
  it('tags the chunk-level size check as permanent (chunked retry path)', async () => {
    const service = new WhisperTranscriptionService();

    let thrown: TranscriptionError | undefined;
    try {
      await service.transcribeChunk(oversizedPath);
    } catch (error) {
      thrown = error as TranscriptionError;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.errorClass).toBe('permanent');
    expect(thrown!.message).toContain('transcription limit');
  });
});

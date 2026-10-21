/**
 * Azure AI Speech fast transcription service.
 *
 * Synchronous speech-to-text for languages the hosted Whisper API rejects
 * (for example Somali `so` → `so-SO`) and as a user-selectable alternative
 * engine for languages both services support. A separate model family from
 * Whisper: output quality differs per language and must be judged on its own.
 *
 * API: POST {endpoint}/speechtotext/transcriptions:transcribe
 * Multipart form: `audio` (file) + `definition` (JSON with `locales`).
 * Limits: audio under 5 hours and under 500 MB — large uploads need no
 * chunking on this path, unlike Whisper's 25 MB cap.
 *
 * @see https://learn.microsoft.com/azure/ai-services/speech-service/fast-transcription-create
 */
import {
  cleanUpFiles,
  isBase64,
  saveBase64AsFile,
} from '@/lib/services/transcription/common';

import {
  ITranscriptionService,
  TranscriptionError,
  TranscriptionErrorClass,
  TranscriptionOptions,
} from '@/types/transcription';

import { env } from '@/config/environment';
import { getAzureSpeechLocales } from '@/lib/constants/transcriptionLanguages';
import fs from 'fs';
import path from 'path';

/** Fast transcription API input cap (bytes). The API also caps at 5 hours. */
export const FAST_TRANSCRIPTION_MAX_SIZE = 500 * 1024 * 1024;

const API_VERSION = '2025-10-15';

export class FastTranscriptionService implements ITranscriptionService {
  private endpoint: string;
  private apiKey: string;

  constructor() {
    const region = env.AZURE_SPEECH_REGION || 'eastus';
    this.endpoint =
      env.AZURE_SPEECH_ENDPOINT ||
      `https://${region}.api.cognitive.microsoft.com`;
    this.apiKey = env.AZURE_SPEECH_KEY || '';
  }

  isAvailable(): boolean {
    return !!this.apiKey;
  }

  async transcribe(
    input: string,
    options?: TranscriptionOptions,
  ): Promise<string> {
    if (!this.isAvailable()) {
      const err = new Error(
        'Azure Speech transcription is not configured (AZURE_SPEECH_KEY missing).',
      ) as TranscriptionError;
      err.errorClass = 'permanent';
      throw err;
    }

    let filePath: string;
    let shouldCleanup = false;
    if (isBase64(input)) {
      filePath = await saveBase64AsFile(input);
      shouldCleanup = true;
    } else {
      filePath = input;
    }

    try {
      const locales = getAzureSpeechLocales(options?.language);
      if (options?.language && locales.length === 0) {
        const err = new Error(
          `Azure Speech transcription has no locale for language '${options.language}'.`,
        ) as TranscriptionError;
        err.errorClass = 'permanent';
        throw err;
      }

      const buffer = await this.readAudioWithinLimit(filePath);

      const form = new FormData();
      form.append(
        'audio',
        new Blob([new Uint8Array(buffer)]),
        path.basename(filePath),
      );
      form.append(
        'definition',
        JSON.stringify({
          locales,
          // Whisper does not mask words; keep raw speech so medical and
          // testimonial content is not silently altered.
          profanityFilterMode: 'None',
        }),
      );

      const url = `${this.endpoint.replace(/\/$/, '')}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Ocp-Apim-Subscription-Key': this.apiKey },
          body: form,
        });
      } catch (networkError) {
        const err = new Error(
          `Azure Speech transcription request failed: ${networkError instanceof Error ? networkError.message : String(networkError)}`,
        ) as TranscriptionError;
        err.errorClass = 'transient';
        throw err;
      }

      if (!response.ok) {
        throw await this.toTranscriptionError(response);
      }

      const result = (await response.json()) as {
        combinedPhrases?: Array<{ text?: string }>;
      };
      return (result.combinedPhrases ?? [])
        .map((phrase) => phrase.text ?? '')
        .join('\n')
        .trim();
    } finally {
      if (shouldCleanup) {
        void cleanUpFiles([filePath]);
      }
    }
  }

  /**
   * Size-check and read through one file handle so the file that is measured
   * is the file that is sent (no stat-then-read window on the path).
   */
  private async readAudioWithinLimit(filePath: string): Promise<Buffer> {
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const stats = await handle.stat();
      if (stats.size > FAST_TRANSCRIPTION_MAX_SIZE) {
        const maxMB = FAST_TRANSCRIPTION_MAX_SIZE / (1024 * 1024);
        const sizeError = new Error(
          `Audio file size (${(stats.size / 1024 / 1024).toFixed(2)}MB) exceeds the ${maxMB}MB Azure Speech transcription limit. Please upload a shorter audio file.`,
        ) as TranscriptionError;
        sizeError.errorClass = 'permanent';
        throw sizeError;
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  private async toTranscriptionError(
    response: Response,
  ): Promise<TranscriptionError> {
    const status = response.status;
    let detail = '';
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      detail = body.error?.message || body.error?.code || '';
    } catch {
      // Non-JSON error body; status alone classifies the failure.
    }

    let errorClass: TranscriptionErrorClass = 'unknown';
    let message = detail || `HTTP ${status}`;
    let retryAfterSeconds: number | undefined;
    if (status === 429) {
      errorClass = 'rate_limit';
      const header = response.headers.get('retry-after');
      const parsed = header ? Number(header) : NaN;
      if (Number.isFinite(parsed) && parsed > 0 && parsed <= 600) {
        retryAfterSeconds = Math.ceil(parsed);
      }
      message = `The audio transcription service is currently at capacity due to high usage. Please wait ${retryAfterSeconds ?? 'a few'} seconds and try again.`;
    } else if (status === 401 || status === 403) {
      errorClass = 'auth';
      message = `Audio transcription auth failed (${status}): ${detail || 'Unauthorized'}`;
    } else if (status >= 500) {
      errorClass = 'transient';
      message = `Audio transcription service error (${status}): ${detail || 'Server error'}`;
    } else if (status >= 400) {
      errorClass = 'permanent';
      message = `Audio transcription rejected (${status}): ${detail || 'Bad request'}`;
    }

    const tagged = new Error(
      `Error transcribing with Azure Speech: ${message}`,
    ) as TranscriptionError;
    tagged.errorClass = errorClass;
    tagged.retryAfterSeconds = retryAfterSeconds;
    return tagged;
  }
}

let instance: FastTranscriptionService | undefined;
export function getFastTranscriptionService(): FastTranscriptionService {
  if (!instance) instance = new FastTranscriptionService();
  return instance;
}

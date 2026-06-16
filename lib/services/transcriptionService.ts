import { BatchTranscriptionService } from '@/lib/services/transcription/batchTranscriptionService';
import { WhisperTranscriptionService } from '@/lib/services/transcription/whisperTranscriptionService';

import { WHISPER_MAX_SIZE } from '@/lib/utils/app/const';

import { ITranscriptionService } from '@/types/transcription';

/**
 * Supported transcription service types
 */
export type TranscriptionServiceType = 'whisper' | 'batch';

/**
 * Factory for creating transcription service instances.
 *
 * Routes transcription requests based on file size:
 * - Files ≤25MB: Whisper (synchronous)
 * - Files >25MB: Azure Speech Batch (asynchronous) — DEPRECATED, used only
 *   by the legacy /api/file/[id]/transcribe route. The chat pipeline
 *   (FileProcessor) handles >25MB files with ChunkedTranscriptionService
 *   (ffmpeg split → parallel Whisper) instead; see
 *   lib/services/transcription/chunkedTranscriptionService.ts.
 */
export class TranscriptionServiceFactory {
  /**
   * Creates a transcription service instance.
   *
   * @param method - The transcription method to use
   * @returns The appropriate transcription service
   * @throws Error if method is not recognized
   */
  static getTranscriptionService(
    method: TranscriptionServiceType,
  ): ITranscriptionService {
    switch (method) {
      case 'whisper':
        return new WhisperTranscriptionService();
      case 'batch':
        return new BatchTranscriptionService();
      default:
        throw new Error(`Invalid transcription method: ${method}`);
    }
  }

  /**
   * Determines which transcription service to use based on file size.
   *
   * @param fileSize - Size of the audio file in bytes
   * @returns 'whisper' for files ≤25MB, 'batch' for larger files
   */
  static getServiceTypeForFileSize(fileSize: number): TranscriptionServiceType {
    return fileSize <= WHISPER_MAX_SIZE ? 'whisper' : 'batch';
  }

  /**
   * Creates the appropriate batch transcription service.
   *
   * This is a convenience method for when you specifically need the batch
   * service (which has additional methods beyond ITranscriptionService).
   *
   * @returns BatchTranscriptionService instance
   */
  static getBatchService(): BatchTranscriptionService {
    return new BatchTranscriptionService();
  }
}

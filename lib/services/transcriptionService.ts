import { WhisperTranscriptionService } from '@/lib/services/transcription/whisperTranscriptionService';

import { ITranscriptionService } from '@/types/transcription';

export class TranscriptionServiceFactory {
  static getTranscriptionService(method: 'whisper'): ITranscriptionService {
    if (method === 'whisper') {
      return new WhisperTranscriptionService();
    } else {
      throw new Error('Invalid transcription method');
    }
  }
}

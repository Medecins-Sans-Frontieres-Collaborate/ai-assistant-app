import {
  cleanUpFiles,
  isBase64,
  saveBase64AsFile,
} from '@/lib/services/transcription/common';

import { ITranscriptionService } from '@/types/transcription';

import { env } from '@/config/environment';
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import fs from 'fs';
import { AzureOpenAI } from 'openai';

export class WhisperTranscriptionService implements ITranscriptionService {
  private modelName: string = 'whisper-1';
  private deployment: string;
  private client: AzureOpenAI;

  constructor() {
    const apiKey = env.OPENAI_API_KEY;
    const azureEndpoint = env.AZURE_OPENAI_ENDPOINT;
    const deployment = 'whisper';
    const apiVersion = env.OPENAI_API_VERSION;

    if (!azureEndpoint) {
      throw new Error('AZURE_OPENAI_ENDPOINT is not set.');
    }

    this.deployment = deployment;

    // Initialize Azure OpenAI client with either API key or Azure AD auth
    if (apiKey) {
      this.client = new AzureOpenAI({
        apiKey,
        endpoint: azureEndpoint,
        apiVersion,
        deployment: this.deployment,
      });
    } else {
      const credential = new DefaultAzureCredential();
      const scope = 'https://cognitiveservices.azure.com/.default';
      const azureADTokenProvider = getBearerTokenProvider(credential, scope);

      this.client = new AzureOpenAI({
        endpoint: azureEndpoint,
        apiVersion,
        deployment: this.deployment,
        azureADTokenProvider,
      });
    }
  }

  async transcribe(input: string): Promise<string> {
    let filePath: string;
    let shouldCleanup = false;

    if (isBase64(input)) {
      filePath = await saveBase64AsFile(input);
      shouldCleanup = true;
    } else {
      filePath = input;
    }

    try {
      // Check file size (Whisper API limit is 25MB)
      const maxSize = 25 * 1024 * 1024; // 25MB
      const stats = await fs.promises.stat(filePath);
      const fileSize = stats.size;

      if (fileSize > maxSize) {
        throw new Error(
          `Audio file size (${(fileSize / 1024 / 1024).toFixed(2)}MB) exceeds the maximum limit of 25MB. Please upload a shorter audio file.`,
        );
      }

      // Transcribe the file directly (Whisper supports mp3, mp4, mpeg, mpga, m4a, wav, webm)
      const transcript = await this.transcribeSegment(filePath);

      return transcript;
    } finally {
      // Clean up temporary file if we created it from base64
      if (shouldCleanup) {
        void cleanUpFiles([filePath]);
      }
    }
  }

  private async transcribeSegment(segmentPath: string): Promise<string> {
    const stats = await fs.promises.stat(segmentPath);
    const fileSize = stats.size;

    if (fileSize > 25 * 1024 * 1024) {
      throw new Error('Segment size exceeds the maximum allowed size of 25MB.');
    }

    try {
      // Use OpenAI SDK which handles file streams properly
      const transcription = await this.client.audio.transcriptions.create({
        file: fs.createReadStream(segmentPath),
        model: this.deployment,
        // Optional: Uncomment to specify language for better accuracy
        // language: 'en', // ISO-639-1 format (e.g., 'en', 'es', 'fr')
        // Optional: Uncomment to provide context for better accuracy with technical terms
        // prompt: 'This is a transcription of a conversation about...',
        // Optional: Temperature for sampling (0-1). Lower = more deterministic
        temperature: 0, // Most deterministic transcription
      });

      return transcription.text || '';
    } catch (error: any) {
      // Handle rate limit errors with user-friendly message
      if (error.status === 429 || error.code === 'rate_limit_exceeded') {
        const retryAfterMatch = error.message?.match(
          /retry after (\d+) seconds?/i,
        );
        const waitTime = retryAfterMatch ? retryAfterMatch[1] : 'a few';

        throw new Error(
          `The audio transcription service is currently at capacity due to high usage. Please wait ${waitTime} seconds and try again. Note: This is a shared service, so capacity may be affected by other users.`,
        );
      }

      const errorMessage = error.message || 'Unknown error';
      throw new Error(`Error transcribing segment: ${errorMessage}`);
    }
  }
}

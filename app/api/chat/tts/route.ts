import { Session } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';

import { detectLanguage } from '@/lib/services/languageDetection';
import { guardLimit } from '@/lib/services/limits/routeGuard';

import { cleanMarkdown } from '@/lib/utils/app/clean';
import { unauthorizedResponse } from '@/lib/utils/server/api/apiResponse';
import { createApiLoggingContext } from '@/lib/utils/server/observability';

import {
  DEFAULT_TTS_SETTINGS,
  TTSOutputFormat,
  TTSRequest,
  TTSSettings,
} from '@/types/tts';

import { auth } from '@/auth';
import {
  getBaseLanguageCode,
  getDefaultVoiceForLocale,
  getTTSLocaleForAppLocale,
  isMultilingualVoice,
  resolveVoiceForLanguage,
} from '@/lib/data/ttsVoices';
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { Readable } from 'stream';

/**
 * Map of TTSOutputFormat to SDK SpeechSynthesisOutputFormat.
 */
const OUTPUT_FORMAT_MAP: Record<
  TTSOutputFormat,
  sdk.SpeechSynthesisOutputFormat
> = {
  Audio16Khz32KBitRateMonoMp3:
    sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3,
  Audio16Khz64KBitRateMonoMp3:
    sdk.SpeechSynthesisOutputFormat.Audio16Khz64KBitRateMonoMp3,
  Audio24Khz48KBitRateMonoMp3:
    sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3,
  Audio24Khz96KBitRateMonoMp3:
    sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3,
  Audio48Khz96KBitRateMonoMp3:
    sdk.SpeechSynthesisOutputFormat.Audio48Khz96KBitRateMonoMp3,
  Audio48Khz192KBitRateMonoMp3:
    sdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3,
};

/**
 * Escapes text for use in SSML.
 * Escapes XML special characters to prevent SSML parsing errors.
 *
 * @param text - The text to escape
 * @returns The escaped text safe for SSML
 */
function escapeForSSML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds SSML markup for speech synthesis with prosody settings.
 *
 * @param text - The text to speak
 * @param voiceName - The voice name to use
 * @param rate - Speech rate (0.5 to 2.0)
 * @param pitch - Pitch adjustment (-50 to +50)
 * @returns SSML string
 */
function buildSSML(
  text: string,
  voiceName: string,
  rate: number,
  pitch: number,
): string {
  // Convert rate to percentage (1.0 = default, 0.5 = -50%, 2.0 = +100%)
  const ratePercent = Math.round((rate - 1) * 100);
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

  // Pitch is already in percentage
  const pitchStr = pitch >= 0 ? `+${pitch}%` : `${pitch}%`;

  const escapedText = escapeForSSML(text);

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">
  <voice name="${voiceName}">
    <prosody rate="${rateStr}" pitch="${pitchStr}">
      ${escapedText}
    </prosody>
  </voice>
</speak>`;
}

/**
 * Converts chat response text to speech using Azure Speech Services.
 *
 * POST /api/chat/tts
 *
 * Request body:
 * - text: string (required) - The text to convert to speech
 * - voiceName: string (optional) - Explicit voice override (skips all resolution)
 * - detectedLanguage: string (optional) - Pre-detected language hint
 * - rate: number (optional) - Speech rate (0.5 to 2.0, default 1.0)
 * - pitch: number (optional) - Pitch adjustment (-50 to +50, default 0)
 * - outputFormat: TTSOutputFormat (optional) - Audio output format
 * - globalVoice: string (optional) - User's global fallback voice preference
 * - languageVoices: Record<string, string> (optional) - Per-language voice preferences
 *
 * Voice resolution priority:
 * 1. Explicit voiceName override → use directly
 * 2. globalVoice is multilingual → use without detection
 * 3. Detect language, then check languageVoices[baseLanguage]
 * 4. Fall back to globalVoice or system default
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const session: Session | null = await auth();
  if (!session?.user) {
    return unauthorizedResponse();
  }

  const ctx = createApiLoggingContext();

  try {
    const body: TTSRequest = await request.json();
    const {
      text,
      voiceName,
      detectedLanguage,
      rate,
      pitch,
      outputFormat,
      globalVoice,
      languageVoices,
    } = body;

    // Validate input before processing - check raw input, not processed output
    if (typeof text !== 'string' || text.trim().length === 0) {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 });
    }

    // Usage limits (docs/LIMITS.md). Checked on the RAW text, before any
    // synthesis work: TTS is the largest unbounded cost surface in the app —
    // until this landed its only validation was that `text` is a non-empty
    // string. `feature.tts.charactersPerRequest` caps a single read-aloud;
    // `feature.tts.charactersPerDay` caps the running total.
    const ttsGuard = await guardLimit(session, 'feature.tts.charactersPerDay', {
      amount: text.length,
      ceilingKey: 'feature.tts.charactersPerRequest',
      req: request,
    });
    if (!ttsGuard.allowed && ttsGuard.response) {
      return ttsGuard.response;
    }

    const cleanedText = cleanMarkdown(text);

    // Additional safety check after sanitization
    if (!cleanedText || cleanedText.trim().length === 0) {
      return NextResponse.json(
        { error: 'Text could not be processed' },
        { status: 400 },
      );
    }

    // Build settings object from user preferences
    const settings: TTSSettings = {
      globalVoice: globalVoice ?? DEFAULT_TTS_SETTINGS.globalVoice,
      languageVoices: languageVoices ?? {},
      rate: rate ?? DEFAULT_TTS_SETTINGS.rate,
      pitch: pitch ?? DEFAULT_TTS_SETTINGS.pitch,
      outputFormat: outputFormat ?? DEFAULT_TTS_SETTINGS.outputFormat,
    };

    // Determine the voice to use based on priority hierarchy
    let effectiveVoiceName: string;

    if (voiceName) {
      // Priority 1: Explicit voice override - use directly
      effectiveVoiceName = voiceName;
    } else if (
      settings.globalVoice &&
      isMultilingualVoice(settings.globalVoice) &&
      Object.keys(settings.languageVoices).length === 0
    ) {
      // Priority 2: Global voice is multilingual AND no language preferences - skip detection
      effectiveVoiceName = settings.globalVoice;
    } else {
      // Priority 3: Need to detect language to resolve voice
      let languageCode = detectedLanguage;

      if (!languageCode) {
        // Detect language from the text
        const detectionResult = await detectLanguage(cleanedText);
        languageCode = detectionResult.language;
      }

      // Get base language code (e.g., "en" from "en-US")
      const baseLanguage = getBaseLanguageCode(languageCode);

      // Resolve voice using the user's preferences
      effectiveVoiceName = resolveVoiceForLanguage(baseLanguage, settings);
    }
    const effectiveRate = rate ?? DEFAULT_TTS_SETTINGS.rate;
    const effectivePitch = pitch ?? DEFAULT_TTS_SETTINGS.pitch;
    const effectiveOutputFormat =
      outputFormat ?? DEFAULT_TTS_SETTINGS.outputFormat;

    // Validate rate and pitch ranges
    if (effectiveRate < 0.5 || effectiveRate > 2.0) {
      return NextResponse.json(
        { error: 'Rate must be between 0.5 and 2.0' },
        { status: 400 },
      );
    }
    if (effectivePitch < -50 || effectivePitch > 50) {
      return NextResponse.json(
        { error: 'Pitch must be between -50 and 50' },
        { status: 400 },
      );
    }

    // Azure Speech Services configuration
    const region = process.env.AZURE_SPEECH_REGION || 'eastus';
    const subscriptionKey = process.env.AZURE_SPEECH_KEY;

    let speechConfig: sdk.SpeechConfig;

    if (subscriptionKey) {
      // Use subscription key authentication
      speechConfig = sdk.SpeechConfig.fromSubscription(subscriptionKey, region);
    } else {
      // Fall back to managed identity (Entra ID) token
      const { DefaultAzureCredential } = await import('@azure/identity');
      const credential = new DefaultAzureCredential();
      const tokenResponse = await credential.getToken(
        'https://cognitiveservices.azure.com/.default',
      );

      if (!tokenResponse || !tokenResponse.token) {
        throw new Error(
          'Failed to get authentication token for Speech Services',
        );
      }

      speechConfig = sdk.SpeechConfig.fromAuthorizationToken(
        tokenResponse.token,
        region,
      );
    }

    // Set output format
    speechConfig.speechSynthesisOutputFormat =
      OUTPUT_FORMAT_MAP[effectiveOutputFormat] ??
      sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3;

    // Set the voice name
    speechConfig.speechSynthesisVoiceName = effectiveVoiceName;

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig);

    // Determine if we need SSML (for custom rate/pitch)
    const needsSSML = effectiveRate !== 1.0 || effectivePitch !== 0;

    return new Promise((resolve, reject) => {
      const handleResult = (result: sdk.SpeechSynthesisResult) => {
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          // Log success
          void ctx.logger.logTTSSuccess({
            user: session.user,
            textLength: cleanedText.length,
            targetLanguage: effectiveVoiceName.split('-').slice(0, 2).join('-'),
            voiceName: effectiveVoiceName,
            audioFormat: effectiveOutputFormat,
            duration: ctx.timer.elapsed(),
          });

          // Stream the audio file back to the user
          const audioData = result.audioData;
          const stream = new Readable();
          stream.push(Buffer.from(audioData));
          stream.push(null);

          const response = new NextResponse(
            stream as unknown as ReadableStream,
            {
              status: 200,
              headers: {
                'Content-Type': 'audio/mpeg',
                'Content-Disposition': 'attachment; filename="speech.mp3"',
              },
            },
          );

          resolve(response);
        } else {
          // Get detailed cancellation error information
          const cancellationDetails =
            sdk.CancellationDetails.fromResult(result);
          const errorDetails = `Speech synthesis canceled. Reason: ${cancellationDetails.reason}, ErrorCode: ${cancellationDetails.ErrorCode}, ErrorDetails: ${cancellationDetails.errorDetails}`;
          console.error(errorDetails);

          // Log error
          void ctx.logger.logTTSError({
            user: session.user,
            textLength: cleanedText.length,
            targetLanguage: effectiveVoiceName.split('-').slice(0, 2).join('-'),
            voiceName: effectiveVoiceName,
            errorCode: String(cancellationDetails.ErrorCode),
            errorMessage: errorDetails,
          });

          reject(new Error(errorDetails));
        }
        synthesizer.close();
      };

      const handleError = (error: string) => {
        console.error('TTS error callback:', error);

        // Log error
        void ctx.logger.logTTSError({
          user: session.user,
          textLength: cleanedText.length,
          targetLanguage: effectiveVoiceName.split('-').slice(0, 2).join('-'),
          voiceName: effectiveVoiceName,
          errorCode: 'TTS_CALLBACK_ERROR',
          errorMessage: error,
        });

        synthesizer.close();
        reject(new Error(error));
      };

      if (needsSSML) {
        // Use SSML for custom rate/pitch
        const ssml = buildSSML(
          cleanedText,
          effectiveVoiceName,
          effectiveRate,
          effectivePitch,
        );
        synthesizer.speakSsmlAsync(ssml, handleResult, handleError);
      } else {
        // Use plain text for default settings (more efficient)
        synthesizer.speakTextAsync(cleanedText, handleResult, handleError);
      }
    });
  } catch (error) {
    console.error('Error in text-to-speech conversion:', error);

    // Log error
    void ctx.logger.logTTSError({
      user: session.user,
      errorCode: 'TTS_INTERNAL_ERROR',
      errorMessage: ctx.getErrorMessage(error),
    });

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

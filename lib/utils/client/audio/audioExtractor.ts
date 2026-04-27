/**
 * Client-side audio extraction from video files using FFmpeg.wasm.
 * Extracts audio tracks from video files in the browser to reduce upload size
 * for transcription workflows.
 */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

/**
 * Result of audio extraction
 */
export interface AudioExtractionResult {
  audioBlob: Blob;
  audioFile: File;
  originalSize: number;
  extractedSize: number;
  originalFilename: string;
  outputFilename: string;
  durationSeconds?: number;
  compressionRatio: number;
}

/**
 * Progress callback for extraction
 */
export type ExtractionProgressCallback = (progress: {
  stage: 'loading' | 'extracting' | 'encoding' | 'complete';
  percent: number;
  message: string;
}) => void;

/**
 * Audio extraction options
 */
export interface ExtractionOptions {
  outputFormat?: 'mp3' | 'wav' | 'm4a';
  quality?: 'low' | 'medium' | 'high';
  onProgress?: ExtractionProgressCallback;
}

/**
 * Hard memory ceiling for client-side extraction. ffmpeg.wasm holds the full
 * input file in JS memory (`fetchFile` materializes the bytes, `writeFile`
 * copies them into the WASM filesystem). On low-RAM devices that crashes
 * the tab. Files above this threshold get uploaded as-is and the server-side
 * transcription pipeline (which uses a real ffmpeg binary) handles them.
 */
const MAX_CLIENT_EXTRACTION_BYTES = 200 * 1024 * 1024;

/**
 * Timeout for the FFmpeg WASM CDN fetch. Corporate networks often block
 * unpkg / third-party CDNs, in which case the browser eventually times out
 * but very slowly (default ~5min in some browsers). Failing fast lets us
 * fall back to direct video upload before the user gives up.
 */
const FFMPEG_WASM_LOAD_TIMEOUT_MS = 30_000;

/**
 * Thrown when client-side extraction is unavailable for a recoverable
 * reason. Callers should fall back to uploading the raw video. The
 * "unsupported browser" case is signalled via `isAudioExtractionSupported`
 * returning false rather than a thrown error, so it doesn't appear here.
 */
export class AudioExtractionUnavailableError extends Error {
  constructor(
    message: string,
    public readonly reason: 'cdn' | 'memory',
  ) {
    super(message);
    this.name = 'AudioExtractionUnavailableError';
  }
}

// Singleton FFmpeg instance
let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoading: Promise<FFmpeg> | null = null;

/**
 * Gets or creates the FFmpeg instance.
 * Uses lazy loading to only load the ~25MB WASM bundle when needed.
 */
async function getFFmpeg(
  onProgress?: ExtractionProgressCallback,
): Promise<FFmpeg> {
  if (ffmpegInstance) {
    return ffmpegInstance;
  }

  if (ffmpegLoading) {
    return ffmpegLoading;
  }

  ffmpegLoading = (async () => {
    const ffmpeg = new FFmpeg();

    // Set up progress handler
    ffmpeg.on('progress', ({ progress }: { progress: number }) => {
      onProgress?.({
        stage: 'extracting',
        percent: Math.round(progress * 100),
        message: `Extracting audio: ${Math.round(progress * 100)}%`,
      });
    });

    ffmpeg.on('log', ({ message }: { message: string }) => {
      // Parse duration from FFmpeg logs if available
      console.debug('[FFmpeg]', message);
    });

    onProgress?.({
      stage: 'loading',
      percent: 0,
      message: 'Loading audio extraction engine...',
    });

    // Load FFmpeg WASM from CDN
    // Using unpkg for better reliability
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

    try {
      // Race the CDN fetch against a timeout so a blocked or very slow
      // network fails fast rather than hanging for minutes.
      const withTimeout = <T>(p: Promise<T>): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new AudioExtractionUnavailableError(
                    'Timed out fetching FFmpeg WASM from CDN',
                    'cdn',
                  ),
                ),
              FFMPEG_WASM_LOAD_TIMEOUT_MS,
            ),
          ),
        ]);

      const [coreURL, wasmURL] = await Promise.all([
        withTimeout(toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript')),
        withTimeout(
          toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        ),
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
    } catch (error) {
      console.error('Failed to load FFmpeg from CDN:', error);
      // Reset the loading promise so a retry (e.g., after the user
      // changes networks) gets a fresh attempt rather than the
      // already-rejected one.
      ffmpegLoading = null;
      if (error instanceof AudioExtractionUnavailableError) {
        throw error;
      }
      throw new AudioExtractionUnavailableError(
        'Failed to load audio extraction engine',
        'cdn',
      );
    }

    onProgress?.({
      stage: 'loading',
      percent: 100,
      message: 'Audio extraction engine ready',
    });

    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return ffmpegLoading;
}

/**
 * Gets FFmpeg quality arguments based on quality setting
 */
function getQualityArgs(
  format: 'mp3' | 'wav' | 'm4a',
  quality: 'low' | 'medium' | 'high',
): string[] {
  const qualityMap = {
    mp3: {
      low: ['-q:a', '6'], // ~128kbps VBR
      medium: ['-q:a', '4'], // ~165kbps VBR
      high: ['-q:a', '2'], // ~190kbps VBR
    },
    m4a: {
      low: ['-b:a', '96k'],
      medium: ['-b:a', '128k'],
      high: ['-b:a', '192k'],
    },
    wav: {
      // WAV is lossless, quality doesn't apply
      low: [],
      medium: [],
      high: [],
    },
  };

  return qualityMap[format][quality];
}

/**
 * Extracts audio from a video file.
 *
 * @param videoFile - The video file to extract audio from
 * @param options - Extraction options
 * @returns Promise resolving to extraction result
 * @throws Error if extraction fails
 */
export async function extractAudioFromVideo(
  videoFile: File,
  options: ExtractionOptions = {},
): Promise<AudioExtractionResult> {
  const { outputFormat = 'mp3', quality = 'medium', onProgress } = options;

  // Validate input
  if (!videoFile || videoFile.size === 0) {
    throw new Error('Invalid video file');
  }

  // Bail out for files too large to safely buffer in JS heap. The server-
  // side transcription pipeline handles these natively.
  if (videoFile.size > MAX_CLIENT_EXTRACTION_BYTES) {
    throw new AudioExtractionUnavailableError(
      `Video too large for client-side extraction (${formatFileSize(videoFile.size)} > ${formatFileSize(MAX_CLIENT_EXTRACTION_BYTES)})`,
      'memory',
    );
  }

  const ffmpeg = await getFFmpeg(onProgress);

  // Generate filenames
  const inputExt = videoFile.name.split('.').pop() || 'mp4';
  const inputFilename = `input.${inputExt}`;
  const outputFilename = `output.${outputFormat}`;
  const baseFilename = videoFile.name.replace(/\.[^/.]+$/, '');
  const finalFilename = `${baseFilename}.${outputFormat}`;

  onProgress?.({
    stage: 'extracting',
    percent: 0,
    message: 'Preparing video file...',
  });

  try {
    // Write input file to FFmpeg virtual filesystem
    const videoData = await fetchFile(videoFile);
    await ffmpeg.writeFile(inputFilename, videoData);

    onProgress?.({
      stage: 'extracting',
      percent: 10,
      message: 'Starting audio extraction...',
    });

    // Build FFmpeg command
    const qualityArgs = getQualityArgs(outputFormat, quality);
    const codecMap = {
      mp3: 'libmp3lame',
      m4a: 'aac',
      wav: 'pcm_s16le',
    };

    const args = [
      '-i',
      inputFilename,
      '-vn', // No video
      '-acodec',
      codecMap[outputFormat],
      ...qualityArgs,
      '-y', // Overwrite output
      outputFilename,
    ];

    // Execute FFmpeg command
    await ffmpeg.exec(args);

    onProgress?.({
      stage: 'encoding',
      percent: 90,
      message: 'Finalizing audio file...',
    });

    // Read output file
    const outputData = await ffmpeg.readFile(outputFilename);
    if (!(outputData instanceof Uint8Array)) {
      throw new Error('Failed to read extracted audio');
    }

    // Clean up virtual filesystem
    await ffmpeg.deleteFile(inputFilename);
    await ffmpeg.deleteFile(outputFilename);

    // Create blob and file
    const mimeType =
      outputFormat === 'mp3'
        ? 'audio/mpeg'
        : outputFormat === 'm4a'
          ? 'audio/mp4'
          : 'audio/wav';

    // Cast to ArrayBuffer to satisfy TypeScript - FFmpeg.wasm returns Uint8Array with ArrayBuffer
    const audioBlob = new Blob([outputData as BlobPart], { type: mimeType });
    const audioFile = new File([audioBlob], finalFilename, { type: mimeType });

    const compressionRatio = videoFile.size / audioBlob.size;

    onProgress?.({
      stage: 'complete',
      percent: 100,
      message: `Extracted ${formatFileSize(audioBlob.size)} audio from ${formatFileSize(videoFile.size)} video`,
    });

    return {
      audioBlob,
      audioFile,
      originalSize: videoFile.size,
      extractedSize: audioBlob.size,
      originalFilename: videoFile.name,
      outputFilename: finalFilename,
      compressionRatio,
    };
  } catch (error) {
    // Clean up on error
    try {
      await ffmpeg.deleteFile(inputFilename);
    } catch {
      // Ignore cleanup errors
    }
    try {
      await ffmpeg.deleteFile(outputFilename);
    } catch {
      // Ignore cleanup errors
    }

    console.error('Audio extraction failed:', error);
    throw new Error(
      error instanceof Error
        ? `Audio extraction failed: ${error.message}`
        : 'Audio extraction failed unexpectedly',
    );
  }
}

/**
 * Formats file size in human-readable format
 */
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Checks if audio extraction is supported in the current browser. When a
 * `file` is provided, also checks the file is small enough to buffer in the
 * JS heap — otherwise client-side extraction would risk crashing the tab.
 */
export function isAudioExtractionSupported(file?: File): boolean {
  // Check for required browser APIs
  const hasApis =
    typeof WebAssembly !== 'undefined' &&
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof File !== 'undefined';
  if (!hasApis) return false;
  if (file && file.size > MAX_CLIENT_EXTRACTION_BYTES) return false;
  return true;
}

/**
 * Preloads FFmpeg WASM for faster first use.
 * Call this when user shows intent to upload video (e.g., on dropdown open)
 */
export async function preloadFFmpeg(): Promise<void> {
  try {
    await getFFmpeg();
  } catch (error) {
    console.warn('Failed to preload FFmpeg:', error);
    // Don't throw - preloading failure shouldn't break the app
  }
}

/**
 * Estimates the output audio size based on video duration and quality.
 * This is a rough estimate for UI purposes.
 *
 * @param videoDurationSeconds - Duration of video in seconds
 * @param format - Output format
 * @param quality - Quality setting
 * @returns Estimated size in bytes
 */
export function estimateAudioSize(
  videoDurationSeconds: number,
  format: 'mp3' | 'wav' | 'm4a' = 'mp3',
  quality: 'low' | 'medium' | 'high' = 'medium',
): number {
  // Bitrate estimates in kbps
  const bitrateMap = {
    mp3: { low: 128, medium: 165, high: 190 },
    m4a: { low: 96, medium: 128, high: 192 },
    wav: { low: 1411, medium: 1411, high: 1411 }, // CD quality PCM
  };

  const bitrate = bitrateMap[format][quality];
  // bitrate is in kbps, duration in seconds
  // size = (bitrate * 1000 / 8) * duration
  return Math.ceil((bitrate * 1000 * videoDurationSeconds) / 8);
}

/**
 * Terminates the FFmpeg instance to free memory.
 * Call this when done with extraction tasks.
 */
export async function terminateFFmpeg(): Promise<void> {
  if (ffmpegInstance) {
    try {
      ffmpegInstance.terminate();
    } catch {
      // Ignore termination errors
    }
    ffmpegInstance = null;
    ffmpegLoading = null;
  }
}

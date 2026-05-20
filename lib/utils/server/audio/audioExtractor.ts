/**
 * Server-side audio extraction utilities using FFmpeg.
 * Used to extract audio tracks from video files for transcription.
 *
 * Note: The ffmpeg-static package's __dirname-based path resolution breaks
 * when bundled by Next.js/Turbopack. We use runtime detection with fallbacks:
 * 1. FFMPEG_BIN environment variable
 * 2. npm root + ffmpeg-static location
 * 3. System PATH (if ffmpeg is installed globally)
 */
import { execSync } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';

// Cache the resolved path to avoid repeated lookups
let resolvedFfmpegPath: string | null | undefined = undefined;

/**
 * Resolves the FFmpeg binary path using multiple fallback strategies.
 *
 * Bundlers like Turbopack rewrite __dirname, breaking ffmpeg-static's path
 * resolution. This function provides robust fallbacks:
 *
 * 1. FFMPEG_BIN environment variable (explicit configuration)
 * 2. npm root + ffmpeg-static (works in development)
 * 3. System PATH via 'which ffmpeg' (works if ffmpeg is installed globally)
 *
 * @returns The path to ffmpeg binary, or null if not found
 */
function getFfmpegPath(): string | null {
  // Return cached result if available
  if (resolvedFfmpegPath !== undefined) {
    return resolvedFfmpegPath;
  }

  // Strategy 1: Check environment variable (highest priority)
  if (process.env.FFMPEG_BIN) {
    const envPath = process.env.FFMPEG_BIN;
    if (fs.existsSync(envPath)) {
      console.log(`[AudioExtractor] Using FFmpeg from FFMPEG_BIN: ${envPath}`);
      resolvedFfmpegPath = envPath;
      return envPath;
    } else {
      console.warn(
        `[AudioExtractor] FFMPEG_BIN set but file not found: ${envPath}`,
      );
    }
  }

  // Strategy 2: Try to find via npm root + ffmpeg-static
  try {
    const npmRoot = execSync('npm root', { encoding: 'utf8' }).trim();
    const staticPath = path.join(npmRoot, 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(staticPath)) {
      console.log(
        `[AudioExtractor] Using FFmpeg from ffmpeg-static: ${staticPath}`,
      );
      resolvedFfmpegPath = staticPath;
      return staticPath;
    }
  } catch {
    // npm root command failed, try next strategy
  }

  // Strategy 3: Try process.cwd() based path (for Next.js apps)
  try {
    const cwdPath = path.join(
      process.cwd(),
      'node_modules',
      'ffmpeg-static',
      'ffmpeg',
    );
    if (fs.existsSync(cwdPath)) {
      console.log(`[AudioExtractor] Using FFmpeg from cwd: ${cwdPath}`);
      resolvedFfmpegPath = cwdPath;
      return cwdPath;
    }
  } catch {
    // cwd approach failed, try next strategy
  }

  // Strategy 4: Fall back to system ffmpeg in PATH
  try {
    const whichResult = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    if (whichResult) {
      console.log(`[AudioExtractor] Using system FFmpeg: ${whichResult}`);
      resolvedFfmpegPath = whichResult;
      return whichResult;
    }
  } catch {
    // which command failed (ffmpeg not in PATH)
  }

  console.error(
    '[AudioExtractor] FFmpeg not found. Please either:\n' +
      '  1. Set FFMPEG_BIN environment variable to the ffmpeg binary path\n' +
      '  2. Install ffmpeg globally (apt install ffmpeg / brew install ffmpeg)\n' +
      '  3. Ensure ffmpeg-static is properly installed (npm install ffmpeg-static)',
  );
  resolvedFfmpegPath = null;
  return null;
}

// Cache the resolved ffprobe path to avoid repeated lookups
let resolvedFfprobePath: string | null | undefined = undefined;

/**
 * Resolves the FFprobe binary path using multiple fallback strategies.
 *
 * Similar to getFfmpegPath, but for ffprobe which is needed to inspect
 * media file metadata (e.g., checking if a file has audio streams).
 *
 * @returns The path to ffprobe binary, or null if not found
 */
function getFfprobePath(): string | null {
  // Return cached result if available
  if (resolvedFfprobePath !== undefined) {
    return resolvedFfprobePath;
  }

  // Strategy 1: Check environment variable (highest priority)
  if (process.env.FFPROBE_BIN) {
    const envPath = process.env.FFPROBE_BIN;
    if (fs.existsSync(envPath)) {
      console.log(
        `[AudioExtractor] Using FFprobe from FFPROBE_BIN: ${envPath}`,
      );
      resolvedFfprobePath = envPath;
      return envPath;
    } else {
      console.warn(
        `[AudioExtractor] FFPROBE_BIN set but file not found: ${envPath}`,
      );
    }
  }

  // Strategy 2: Derive from FFmpeg path (ffprobe is typically in same directory)
  const ffmpegBinPath = getFfmpegPath();
  if (ffmpegBinPath) {
    const ffprobeFromFfmpeg = ffmpegBinPath.replace(/ffmpeg$/, 'ffprobe');
    if (fs.existsSync(ffprobeFromFfmpeg)) {
      console.log(
        `[AudioExtractor] Using FFprobe derived from FFmpeg path: ${ffprobeFromFfmpeg}`,
      );
      resolvedFfprobePath = ffprobeFromFfmpeg;
      return ffprobeFromFfmpeg;
    }
  }

  // Strategy 3: Fall back to system ffprobe in PATH
  try {
    const whichResult = execSync('which ffprobe', { encoding: 'utf8' }).trim();
    if (whichResult) {
      console.log(`[AudioExtractor] Using system FFprobe: ${whichResult}`);
      resolvedFfprobePath = whichResult;
      return whichResult;
    }
  } catch {
    // which command failed (ffprobe not in PATH)
  }

  console.warn(
    '[AudioExtractor] FFprobe not found. Audio stream detection will be skipped.',
  );
  resolvedFfprobePath = null;
  return null;
}

// Initialize FFmpeg path
const ffmpegPath = getFfmpegPath();
if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

// Initialize FFprobe path
const ffprobePath = getFfprobePath();
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

export interface AudioExtractionResult {
  outputPath: string;
  duration?: number;
}

export interface AudioExtractionOptions {
  outputFormat?: 'mp3' | 'wav' | 'm4a';
  audioBitrate?: number;
}

/**
 * Returns the appropriate audio codec for the given output format.
 *
 * @param format - The output audio format
 * @returns The codec name for FFmpeg
 */
function getAudioCodec(format: 'mp3' | 'wav' | 'm4a'): string {
  switch (format) {
    case 'mp3':
      return 'libmp3lame';
    case 'wav':
      return 'pcm_s16le';
    case 'm4a':
      return 'aac';
  }
}

/**
 * Checks if an input file contains an audio stream using ffprobe.
 *
 * @param inputPath - Path to the media file
 * @returns Promise resolving to true if the file has an audio stream
 */
async function hasAudioStream(inputPath: string): Promise<boolean> {
  // If ffprobe isn't available, assume audio exists and let ffmpeg handle it
  if (!ffprobePath) {
    console.warn(
      '[AudioExtractor] ffprobe not available, skipping audio stream check',
    );
    return true;
  }

  return new Promise((resolve) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        console.warn(
          '[AudioExtractor] ffprobe failed, assuming audio exists:',
          err.message,
        );
        resolve(true);
        return;
      }

      const audioStream = metadata.streams?.find(
        (stream) => stream.codec_type === 'audio',
      );

      const hasAudio = !!audioStream;
      console.log(
        `[AudioExtractor] Audio stream check: ${hasAudio ? 'found' : 'not found'}`,
      );
      resolve(hasAudio);
    });
  });
}

/**
 * Extracts audio from a video file to the specified format.
 *
 * @param inputPath - Path to the input video file
 * @param options - Extraction options (format, bitrate)
 * @returns Promise resolving to the output file path
 * @throws Error if FFmpeg is not available or extraction fails
 */
export async function extractAudioFromVideo(
  inputPath: string,
  options: AudioExtractionOptions = {},
): Promise<AudioExtractionResult> {
  // Ensure FFmpeg is available before attempting extraction
  if (!ffmpegPath) {
    throw new Error(
      'FFmpeg is not available. Please install FFmpeg or set the FFMPEG_BIN environment variable.',
    );
  }

  const { outputFormat = 'mp3', audioBitrate = 128 } = options;

  // Check if input file has an audio stream before attempting extraction
  const hasAudio = await hasAudioStream(inputPath);
  if (!hasAudio) {
    throw new Error(
      'The video file does not contain an audio track. Cannot extract audio from a video-only file.',
    );
  }

  // Generate output path by replacing extension
  // Handle paths with or without extension (e.g., /tmp/abc123 vs /tmp/abc123.mp4)
  const hasExtension = /\.[^.]+$/.test(inputPath);
  const outputPath = hasExtension
    ? inputPath.replace(/\.[^.]+$/, `_audio.${outputFormat}`)
    : `${inputPath}_audio.${outputFormat}`;

  console.log(`[AudioExtractor] Input: ${inputPath}`);
  console.log(`[AudioExtractor] Output: ${outputPath}`);

  return new Promise((resolve, reject) => {
    // Match the working pattern from audioSplitter.ts:
    // 1. Create command with input
    // 2. Set .output()
    // 3. Apply codec/bitrate settings after
    const command = ffmpeg(inputPath).noVideo().output(outputPath);

    // Apply audio settings (after .output(), matching audioSplitter pattern)
    command.audioCodec(getAudioCodec(outputFormat));
    command.audioBitrate(audioBitrate);

    command
      .on('start', (cmdLine) => {
        console.log(`[AudioExtractor] Running: ${cmdLine}`);
      })
      .on('end', () => {
        console.log(
          `[AudioExtractor] Successfully extracted audio to: ${outputPath}`,
        );
        resolve({ outputPath });
      })
      .on('error', (err: Error) => {
        console.error(`[AudioExtractor] Extraction failed:`, err.message);
        reject(new Error(`Audio extraction failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Checks if FFmpeg is available and properly configured.
 *
 * @returns Promise resolving to true if FFmpeg is available
 */
export async function isFFmpegAvailable(): Promise<boolean> {
  // First check if we have a path
  if (!ffmpegPath) {
    return false;
  }

  // Then verify it actually works
  return new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err) => {
      if (err) {
        console.warn('[AudioExtractor] FFmpeg check failed:', err.message);
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

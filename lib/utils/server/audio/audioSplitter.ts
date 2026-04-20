/**
 * Server-side audio splitting utilities using FFmpeg.
 * Used to split large audio files into smaller chunks for transcription.
 *
 * This module works alongside audioExtractor.ts and uses the same
 * FFmpeg path resolution strategy.
 */
import { execSync } from 'child_process';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';

const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);
const unlink = promisify(fs.unlink);

// Cache the resolved path to avoid repeated lookups
let resolvedFfmpegPath: string | null | undefined = undefined;
let resolvedFfprobePath: string | null | undefined = undefined;

/**
 * Resolves the FFmpeg binary path using multiple fallback strategies.
 * Same strategy as audioExtractor.ts for consistency.
 */
function getFfmpegPath(): string | null {
  if (resolvedFfmpegPath !== undefined) {
    return resolvedFfmpegPath;
  }

  // Strategy 1: Check environment variable
  if (process.env.FFMPEG_BIN) {
    const envPath = process.env.FFMPEG_BIN;
    if (fs.existsSync(envPath)) {
      resolvedFfmpegPath = envPath;
      return envPath;
    }
  }

  // Strategy 2: Try npm root + ffmpeg-static
  try {
    const npmRoot = execSync('npm root', { encoding: 'utf8' }).trim();
    const staticPath = path.join(npmRoot, 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(staticPath)) {
      resolvedFfmpegPath = staticPath;
      return staticPath;
    }
  } catch {
    // npm root command failed
  }

  // Strategy 3: Try process.cwd() based path
  try {
    const cwdPath = path.join(
      process.cwd(),
      'node_modules',
      'ffmpeg-static',
      'ffmpeg',
    );
    if (fs.existsSync(cwdPath)) {
      resolvedFfmpegPath = cwdPath;
      return cwdPath;
    }
  } catch {
    // cwd approach failed
  }

  // Strategy 4: Fall back to system ffmpeg
  try {
    const whichResult = execSync('which ffmpeg', { encoding: 'utf8' }).trim();
    if (whichResult) {
      resolvedFfmpegPath = whichResult;
      return whichResult;
    }
  } catch {
    // which command failed
  }

  resolvedFfmpegPath = null;
  return null;
}

/**
 * Resolves the FFprobe binary path.
 * FFprobe is used to get audio file metadata (duration, bitrate).
 */
function getFfprobePath(): string | null {
  if (resolvedFfprobePath !== undefined) {
    return resolvedFfprobePath;
  }

  // Strategy 1: Check environment variable
  if (process.env.FFPROBE_BIN) {
    const envPath = process.env.FFPROBE_BIN;
    if (fs.existsSync(envPath)) {
      resolvedFfprobePath = envPath;
      return envPath;
    }
  }

  // Strategy 2: Try to derive from FFmpeg path
  const ffmpegPath = getFfmpegPath();
  if (ffmpegPath) {
    const ffprobeFromFfmpeg = ffmpegPath.replace(/ffmpeg$/, 'ffprobe');
    if (fs.existsSync(ffprobeFromFfmpeg)) {
      resolvedFfprobePath = ffprobeFromFfmpeg;
      return ffprobeFromFfmpeg;
    }
  }

  // Strategy 3: Fall back to system ffprobe
  try {
    const whichResult = execSync('which ffprobe', { encoding: 'utf8' }).trim();
    if (whichResult) {
      resolvedFfprobePath = whichResult;
      return whichResult;
    }
  } catch {
    // which command failed
  }

  resolvedFfprobePath = null;
  return null;
}

// Initialize FFmpeg paths
const ffmpegPath = getFfmpegPath();
const ffprobePath = getFfprobePath();

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}
if (ffprobePath) {
  ffmpeg.setFfprobePath(ffprobePath);
}

export interface SplitResult {
  /** Paths to the generated chunk files */
  chunkPaths: string[];
  /** Number of chunks generated */
  chunkCount: number;
  /** Total duration of the original audio in seconds */
  totalDurationSecs: number;
  /** Duration of each chunk in seconds (approximate) */
  chunkDurationSecs: number;
}

export interface SplitOptions {
  /** Target size for each chunk in bytes. Default: 20MB */
  targetChunkSizeBytes?: number;
  /** Output format for chunks. Default: mp3 */
  outputFormat?: 'mp3' | 'wav' | 'm4a';
  /**
   * Output directory for chunks. Default: a per-job subdir under `os.tmpdir()`
   * if `jobId` is set, otherwise same dir as the input file.
   */
  outputDir?: string;
  /**
   * Job identifier. If provided, chunks are written into a dedicated
   * `os.tmpdir()/chunked-transcription/<jobId>/` directory so concurrent jobs
   * don't interleave chunk files and cleanup can simply remove the subdir.
   */
  jobId?: string;
}

/** Default target chunk size: 20MB (safety margin from 25MB Whisper limit) */
const DEFAULT_TARGET_CHUNK_SIZE = 20 * 1024 * 1024;

/**
 * Gets the duration of an audio file in seconds using ffprobe.
 *
 * @param inputPath - Path to the audio file
 * @returns Duration in seconds
 * @throws Error if ffprobe is not available or fails
 */
export async function getAudioDuration(inputPath: string): Promise<number> {
  if (!ffprobePath) {
    throw new Error('FFprobe is not available. Required for audio splitting.');
  }

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to get audio duration: ${err.message}`));
        return;
      }

      const duration = metadata.format.duration;
      if (typeof duration !== 'number' || isNaN(duration)) {
        reject(new Error('Could not determine audio duration'));
        return;
      }

      resolve(duration);
    });
  });
}

/**
 * Gets the bitrate of an audio file in bits per second.
 *
 * @param inputPath - Path to the audio file
 * @returns Bitrate in bits per second
 */
export async function getAudioBitrate(inputPath: string): Promise<number> {
  if (!ffprobePath) {
    throw new Error('FFprobe is not available. Required for audio analysis.');
  }

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(new Error(`Failed to get audio bitrate: ${err.message}`));
        return;
      }

      // Try format bitrate first, then fall back to stream bitrate
      const formatBitrate = metadata.format.bit_rate;
      if (typeof formatBitrate === 'number' && formatBitrate > 0) {
        resolve(formatBitrate);
        return;
      }

      // Look for audio stream bitrate
      const audioStream = metadata.streams?.find(
        (s) => s.codec_type === 'audio',
      );
      if (audioStream?.bit_rate) {
        const streamBitrate = parseInt(String(audioStream.bit_rate), 10);
        if (!isNaN(streamBitrate) && streamBitrate > 0) {
          resolve(streamBitrate);
          return;
        }
      }

      // Estimate from file size and duration if no bitrate available
      const fileSize = metadata.format.size;
      const duration = metadata.format.duration;
      if (
        typeof fileSize === 'number' &&
        typeof duration === 'number' &&
        duration > 0
      ) {
        const estimatedBitrate = (fileSize * 8) / duration;
        resolve(estimatedBitrate);
        return;
      }

      reject(new Error('Could not determine audio bitrate'));
    });
  });
}

/**
 * Calculates the optimal segment duration to achieve the target chunk size.
 *
 * @param inputPath - Path to the audio file
 * @param targetSizeBytes - Target size for each chunk in bytes
 * @returns Segment duration in seconds
 */
async function calculateSegmentDuration(
  inputPath: string,
  targetSizeBytes: number,
): Promise<number> {
  const stats = await stat(inputPath);
  const fileSize = stats.size;

  const duration = await getAudioDuration(inputPath);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Audio has unusable duration');
  }

  // Calculate bytes per second
  const bytesPerSecond = fileSize / duration;

  // Calculate segment duration to achieve target size
  // Round down to be conservative (better to have more chunks than exceed size limit)
  const segmentDuration = Math.floor(targetSizeBytes / bytesPerSecond);

  // Ensure minimum segment duration of 60 seconds
  return Math.max(60, segmentDuration);
}

/**
 * Splits an audio file into smaller chunks using FFmpeg segment feature.
 *
 * Uses stream copy (-c copy) for fast, lossless splitting when possible.
 * Falls back to re-encoding if stream copy fails.
 *
 * @param inputPath - Path to the input audio file
 * @param options - Split options (target size, format, output directory)
 * @returns Promise resolving to split result with chunk paths
 * @throws Error if FFmpeg is not available or splitting fails
 */
export async function splitAudioFile(
  inputPath: string,
  options: SplitOptions = {},
): Promise<SplitResult> {
  if (!ffmpegPath) {
    throw new Error(
      'FFmpeg is not available. Please install FFmpeg or set the FFMPEG_BIN environment variable.',
    );
  }

  const {
    targetChunkSizeBytes = DEFAULT_TARGET_CHUNK_SIZE,
    outputFormat = 'mp3',
    outputDir,
    jobId,
  } = options;

  // Get file info
  const stats = await stat(inputPath);
  const fileSize = stats.size;
  const totalDuration = await getAudioDuration(inputPath);

  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new Error('Audio has unusable duration');
  }

  // If file is small enough, no splitting needed
  if (fileSize <= targetChunkSizeBytes) {
    console.log(
      `[AudioSplitter] File size (${(fileSize / 1024 / 1024).toFixed(1)}MB) is within target, no splitting needed`,
    );
    return {
      chunkPaths: [inputPath],
      chunkCount: 1,
      totalDurationSecs: totalDuration,
      chunkDurationSecs: totalDuration,
    };
  }

  // Calculate segment duration
  let segmentDuration = await calculateSegmentDuration(
    inputPath,
    targetChunkSizeBytes,
  );
  let estimatedChunks = Math.ceil(totalDuration / segmentDuration);

  // Cap chunk count so pathologically long audio doesn't spray hundreds of
  // chunks into tmpdir and the Whisper queue. If we'd exceed the cap, grow
  // segmentDuration so the whole file fits in MAX_CHUNKS segments. The
  // trade-off is chunks can exceed targetChunkSizeBytes, but the transcription
  // service will re-split/retry if Whisper rejects one for size.
  const MAX_CHUNKS = 60;
  if (estimatedChunks > MAX_CHUNKS) {
    segmentDuration = Math.ceil(totalDuration / MAX_CHUNKS);
    estimatedChunks = Math.ceil(totalDuration / segmentDuration);
    console.warn(
      `[AudioSplitter] Chunk count exceeded cap; growing segment duration to ${segmentDuration}s (~${estimatedChunks} chunks)`,
    );
  }

  console.log(
    `[AudioSplitter] Splitting ${(fileSize / 1024 / 1024).toFixed(1)}MB file ` +
      `(${totalDuration.toFixed(0)}s) into ~${estimatedChunks} chunks of ~${segmentDuration}s each`,
  );

  // Prepare output path pattern.
  // Prefer a per-job subdir under tmpdir when jobId is provided so parallel
  // jobs don't share a directory and cleanup can rm-rf the whole subdir.
  const inputBasename = path.basename(inputPath, path.extname(inputPath));
  const outputDirectory =
    outputDir ||
    (jobId
      ? path.join(tmpdir(), 'chunked-transcription', jobId)
      : path.dirname(inputPath));
  if (jobId && !outputDir) {
    await fs.promises.mkdir(outputDirectory, { recursive: true });
  }
  const outputPattern = path.join(
    outputDirectory,
    `${inputBasename}_chunk_%03d.${outputFormat}`,
  );

  // Run FFmpeg segmentation
  await runSegmentation(
    inputPath,
    outputPattern,
    segmentDuration,
    outputFormat,
  );

  // Find all generated chunk files
  const chunkPaths = await findChunkFiles(
    outputDirectory,
    inputBasename,
    outputFormat,
  );

  if (chunkPaths.length === 0) {
    throw new Error('No chunk files were generated');
  }

  console.log(
    `[AudioSplitter] Successfully split into ${chunkPaths.length} chunks`,
  );

  return {
    chunkPaths,
    chunkCount: chunkPaths.length,
    totalDurationSecs: totalDuration,
    chunkDurationSecs: segmentDuration,
  };
}

/**
 * Runs FFmpeg segmentation command.
 *
 * Captures the last 20 stderr lines so a failure's error message includes the
 * actual ffmpeg diagnostic tail rather than a generic "exit code 1". Client-
 * facing errors only get the short message; full stderr goes to server logs.
 */
async function runSegmentation(
  inputPath: string,
  outputPattern: string,
  segmentDuration: number,
  outputFormat: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Ring buffer: newest ffmpeg stderr line pushes the oldest out once the
    // buffer is full. The tail is surfaced in server logs on failure so the
    // operator can tell e.g. "unsupported codec" from "disk full".
    const stderrTail: string[] = [];
    const STDERR_TAIL_CAPACITY = 20;

    const command = ffmpeg(inputPath)
      .outputOptions([
        '-f',
        'segment',
        '-segment_time',
        String(segmentDuration),
        '-reset_timestamps',
        '1',
      ])
      .output(outputPattern);

    // Set audio codec based on format
    switch (outputFormat) {
      case 'mp3':
        command.audioCodec('libmp3lame');
        command.audioBitrate(128);
        break;
      case 'wav':
        command.audioCodec('pcm_s16le');
        break;
      case 'm4a':
        command.audioCodec('aac');
        command.audioBitrate(128);
        break;
    }

    command
      .on('start', (cmdLine) => {
        console.log(`[AudioSplitter] Running: ${cmdLine}`);
      })
      .on('stderr', (line: string) => {
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL_CAPACITY) stderrTail.shift();
      })
      .on('end', () => {
        resolve();
      })
      .on('error', (err: Error) => {
        console.error(
          `[AudioSplitter] Segmentation failed: ${err.message}\n` +
            `--- ffmpeg stderr tail ---\n${stderrTail.join('\n')}`,
        );
        reject(new Error(`Audio segmentation failed: ${err.message}`));
      })
      .run();
  });
}

/**
 * Finds all generated chunk files matching the pattern.
 */
async function findChunkFiles(
  directory: string,
  baseName: string,
  format: string,
): Promise<string[]> {
  const files = await readdir(directory);
  const pattern = new RegExp(`^${baseName}_chunk_\\d{3}\\.${format}$`);

  const chunkFiles = files
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => path.join(directory, f));

  return chunkFiles;
}

/**
 * Cleans up chunk files after processing.
 *
 * @param chunkPaths - Array of chunk file paths to delete
 */
export async function cleanupChunks(chunkPaths: string[]): Promise<void> {
  const results = await Promise.allSettled(
    chunkPaths.map((p) =>
      unlink(p).catch(() => {
        // Ignore errors (file may already be deleted)
      }),
    ),
  );

  const deleted = results.filter((r) => r.status === 'fulfilled').length;
  console.log(
    `[AudioSplitter] Cleaned up ${deleted}/${chunkPaths.length} chunk files`,
  );

  // If all chunks lived in the same per-job subdir under tmpdir/chunked-
  // transcription/, remove the now-empty parent dir too.
  const perJobRoot = path.join(tmpdir(), 'chunked-transcription');
  const parents = new Set(chunkPaths.map((p) => path.dirname(p)));
  for (const parent of parents) {
    if (parent.startsWith(perJobRoot + path.sep)) {
      await fs.promises
        .rm(parent, { recursive: true, force: true })
        .catch(() => {
          // Best-effort; if the dir contained other work or is already gone
          // there's nothing useful to report.
        });
    }
  }
}

/**
 * Checks if audio splitting is available (FFmpeg and FFprobe present).
 */
export function isAudioSplittingAvailable(): boolean {
  return ffmpegPath !== null && ffprobePath !== null;
}

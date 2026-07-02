/**
 * Integration tests for splitAudioFile using the real FFmpeg binary.
 *
 * Regression for issue #57: chunk duration was computed from the INPUT
 * file's bitrate while chunks are re-encoded to mp3 at 128 kbps, so any
 * low-bitrate input (e.g. an iPhone Voice Memo at ~64 kbps AAC) produced
 * chunks far larger than intended — large enough to blow the 25MB Whisper
 * limit and fail the whole transcription job, deterministically per file.
 *
 * The fixture reproduces that shape at small scale: a 32 kbps AAC mono
 * file split with a 1MB target must not yield chunks ~4x the target.
 */
import {
  isAudioSplittingAvailable,
  splitAudioFile,
} from '@/lib/utils/server/audio/audioSplitter';

import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FIXTURE_DURATION_SECS = 600;
const TARGET_CHUNK_BYTES = 1024 * 1024; // 1MB target, scaled-down from prod's 20MB

function resolveFfmpegBinary(): string | null {
  const candidates = [
    process.env.FFMPEG_BIN,
    path.join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const ffmpegBinary = resolveFfmpegBinary();
const canRun = ffmpegBinary !== null && isAudioSplittingAvailable();

// On CI the suite below must actually run — a silent environment skip would
// leave the chunk-sizing regression unprotected while `npm test` stays green.
// ffmpeg comes from ffmpeg-static and ffprobe from ffprobe-static, so a
// failure here means dependency installation broke, not a missing system tool.
it.runIf(process.env.CI)(
  'CI provides ffmpeg + ffprobe (regression suite must not skip)',
  () => {
    expect(canRun).toBe(true);
  },
);

describe.skipIf(!canRun)('splitAudioFile (real ffmpeg)', () => {
  let workDir: string;
  let fixturePath: string;
  let chunkPaths: string[] = [];

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-splitter-test-'));
    fixturePath = path.join(workDir, 'low-bitrate-voice-memo.m4a');

    // 600s of sine at 32 kbps AAC mono ≈ 2.4MB — same low-bitrate shape as
    // an iPhone Voice Memo, cheap enough to encode at test time.
    execFileSync(ffmpegBinary!, [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100',
      '-t',
      String(FIXTURE_DURATION_SECS),
      '-c:a',
      'aac',
      '-b:a',
      '32k',
      '-ac',
      '1',
      '-y',
      fixturePath,
    ]);
  }, 60_000);

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    for (const chunkPath of chunkPaths) {
      fs.rmSync(path.dirname(chunkPath), { recursive: true, force: true });
    }
  });

  it('keeps re-encoded chunks near the target size for low-bitrate input', async () => {
    const result = await splitAudioFile(fixturePath, {
      targetChunkSizeBytes: TARGET_CHUNK_BYTES,
      outputFormat: 'mp3',
      // Unique per run: a fixed id would reuse the same tmp dir, and chunks
      // left by a crashed earlier run match the same filename pattern.
      jobId: `audio-splitter-test-${randomUUID()}`,
    });
    chunkPaths = result.chunkPaths;

    expect(result.chunkCount).toBeGreaterThan(1);
    expect(result.chunkPaths).toHaveLength(result.chunkCount);
    expect(result.totalDurationSecs).toBeGreaterThan(FIXTURE_DURATION_SECS - 5);

    // The whole point: no chunk may meaningfully exceed the target. The
    // pre-fix behavior produced chunks at 128kbps/32kbps = 4x the target.
    for (const chunkPath of result.chunkPaths) {
      const { size } = fs.statSync(chunkPath);
      expect(size).toBeLessThanOrEqual(TARGET_CHUNK_BYTES * 1.25);
    }

    // The chunk bitrate is clamped to the input's: re-encoding 32 kbps audio
    // must not balloon total output to ~4x the source (the 128 kbps ceiling
    // would). Allow 2x for bitrate-step rounding and container overhead.
    const totalChunkBytes = result.chunkPaths.reduce(
      (sum, chunkPath) => sum + fs.statSync(chunkPath).size,
      0,
    );
    expect(totalChunkBytes).toBeLessThanOrEqual(
      fs.statSync(fixturePath).size * 2,
    );

    // Chunks must come back in playback order for transcript assembly.
    expect(result.chunkPaths).toEqual([...result.chunkPaths].sort());
  }, 120_000);

  it('copies a within-target file into the per-job dir instead of returning the input', async () => {
    // Callers treat every returned chunkPath as disposable (cleanupChunks
    // deletes them) — handing back the caller's input file would let that
    // cleanup destroy it.
    const result = await splitAudioFile(fixturePath, {
      // Fixture is ~2.4MB; a 5MB target means "no split needed".
      targetChunkSizeBytes: 5 * 1024 * 1024,
      outputFormat: 'mp3',
      jobId: `audio-splitter-test-${randomUUID()}`,
    });

    expect(result.chunkCount).toBe(1);
    expect(result.chunkPaths[0]).not.toBe(fixturePath);
    expect(fs.existsSync(result.chunkPaths[0])).toBe(true);
    // The copy is byte-identical (no re-encode for a file already in budget).
    expect(fs.statSync(result.chunkPaths[0]).size).toBe(
      fs.statSync(fixturePath).size,
    );

    // Deleting the "chunk" must leave the caller's input intact.
    fs.rmSync(path.dirname(result.chunkPaths[0]), {
      recursive: true,
      force: true,
    });
    expect(fs.existsSync(fixturePath)).toBe(true);
  }, 60_000);

  it('rejects path-unsafe jobIds before touching the filesystem', async () => {
    await expect(
      splitAudioFile(fixturePath, { jobId: '../escape' }),
    ).rejects.toThrow(/invalid jobid/i);
  });

  // Post-split defense-in-depth (audioSplitter's oversized-chunk backstop):
  // a chunk that still exceeds the Whisper cap after splitting can never be
  // transcribed, so the split must fail as a whole with a PERMANENT (never
  // retried) error and clean up its chunk files. The production limit is
  // 25MB; maxChunkSizeBytes is injected small here so the branch fires with
  // the same cheap fixture.
  it('fails permanently and cleans up when a chunk exceeds the max chunk size', async () => {
    const jobId = `audio-splitter-test-${randomUUID()}`;
    const jobDir = path.join(os.tmpdir(), 'chunked-transcription', jobId);

    let caught: (Error & { errorClass?: string }) | null = null;
    try {
      await splitAudioFile(fixturePath, {
        targetChunkSizeBytes: TARGET_CHUNK_BYTES, // forces a real split (~1MB chunks)
        maxChunkSizeBytes: 100 * 1024, // every ~1MB chunk is "oversized"
        outputFormat: 'mp3',
        jobId,
      });
    } catch (error) {
      caught = error as Error & { errorClass?: string };
    }

    expect(caught).not.toBeNull();
    // Non-retryable: chunkedTranscriptionService keys retry policy off this.
    expect(caught!.errorClass).toBe('permanent');
    // User-actionable message, not an internal ffmpeg error.
    expect(caught!.message).toMatch(/could not be split|too long/i);

    // All generated chunks must have been cleaned up.
    if (fs.existsSync(jobDir)) {
      const leftover = fs
        .readdirSync(jobDir)
        .filter((name) => name.includes('_chunk_'));
      expect(leftover).toEqual([]);
    }

    // The caller's input file must be untouched.
    expect(fs.existsSync(fixturePath)).toBe(true);
  }, 120_000);
});

// ===========================================================================
// Codec diversity (issue #90): the original suite only exercised a single
// low-bitrate .m4a fixture. Real-world uploads include video containers
// (m4v, mov, mkv, webm) and non-Whisper-native audio (ogg/opus, flac, aac).
// These tests generate small fixtures for each and assert the splitter can
// demux/decode them into mp3 chunks. They skip (with a clear warning) if the
// bundled ffmpeg-static lacks a needed decoder, rather than hard-failing —
// trusting ffmpeg-static but surfacing a missing codec clearly.
// ===========================================================================

/** Probes whether ffmpeg can decode a given encoder. Returns true if listed. */
function ffmpegHasDecoder(decoder: string): boolean {
  if (!ffmpegBinary) return false;
  try {
    const out = execFileSync(ffmpegBinary, ['-decoders'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    // Decoder lines look like " D.....X  libopus ...". Match the decoder name.
    return new RegExp(`\\b${decoder}\\b`).test(out);
  } catch {
    return false;
  }
}

/**
 * Builds a tiny media fixture at test time via ffmpeg's lavfi source.
 * Returns the fixture path, or null if ffmpeg couldn't encode it (missing
 * muxer/encoder) — callers should skip in that case.
 */
function buildFixture(
  name: string,
  args: string[],
  dir: string,
): string | null {
  const fixture = path.join(dir, name);
  try {
    execFileSync(ffmpegBinary!, ['-y', ...args, fixture], {
      stdio: 'pipe',
    });
    return fs.existsSync(fixture) ? fixture : null;
  } catch {
    return null;
  }
}

describe.skipIf(!canRun)('splitAudioFile codec diversity (issue #90)', () => {
  let workDir: string;
  const generatedChunkDirs: string[] = [];

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-splitter-codec-'));
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
    for (const dir of generatedChunkDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Shared helper: split a fixture and assert basic invariants.
  async function expectSplitsToMp3(
    fixture: string,
    targetBytes: number,
  ): Promise<void> {
    const result = await splitAudioFile(fixture, {
      targetChunkSizeBytes: targetBytes,
      outputFormat: 'mp3',
      jobId: `codec-test-${randomUUID()}`,
    });
    generatedChunkDirs.push(path.dirname(result.chunkPaths[0]));
    expect(result.chunkCount).toBeGreaterThanOrEqual(1);
    expect(result.chunkPaths).toHaveLength(result.chunkCount);
    for (const chunkPath of result.chunkPaths) {
      expect(fs.existsSync(chunkPath)).toBe(true);
      // Each chunk must be a real mp3 (ID3 or frame-sync header).
      const head = fs
        .readFileSync(chunkPath, { encoding: null })
        .subarray(0, 3);
      const isMp3 =
        (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || // "ID3"
        (head[0] === 0xff && (head[1] & 0xe0) === 0xe0); // frame sync
      expect(isMp3, `${chunkPath} is not a valid mp3`).toBe(true);
    }
  }

  it('splits an .m4v (H.264 video + AAC audio) into mp3 chunks', async () => {
    // 60s of H.264 video with AAC audio. The splitter must drop the video
    // stream and transcode the AAC audio to mp3.
    const fixture = buildFixture(
      'clip.m4v',
      [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120:rate=10',
        '-t',
        '60',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
      ],
      workDir,
    );
    if (!fixture) {
      console.warn(
        '[audioSplitter codec test] SKIP m4v: ffmpeg could not encode H.264/AAC fixture',
      );
      return;
    }
    // ~0.5MB AAC over 60s → 256KB target forces a split.
    await expectSplitsToMp3(fixture, 256 * 1024);
  }, 60_000);

  it('splits an .ogg/opus audio file into mp3 chunks', async () => {
    if (!ffmpegHasDecoder('libopus') && !ffmpegHasDecoder('opus')) {
      console.warn(
        '[audioSplitter codec test] SKIP ogg/opus: ffmpeg-static lacks an opus decoder',
      );
      return;
    }
    const fixture = buildFixture(
      'song.opus',
      [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000',
        '-t',
        '60',
        '-c:a',
        'libopus',
        '-b:a',
        '64k',
      ],
      workDir,
    );
    if (!fixture) {
      console.warn(
        '[audioSplitter codec test] SKIP ogg/opus: ffmpeg could not encode the opus fixture',
      );
      return;
    }
    await expectSplitsToMp3(fixture, 256 * 1024);
  }, 60_000);

  it('splits a .flac audio file into mp3 chunks', async () => {
    const fixture = buildFixture(
      'song.flac',
      [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-t',
        '60',
        '-c:a',
        'flac',
      ],
      workDir,
    );
    if (!fixture) {
      console.warn(
        '[audioSplitter codec test] SKIP flac: ffmpeg could not encode the flac fixture',
      );
      return;
    }
    await expectSplitsToMp3(fixture, 256 * 1024);
  }, 60_000);

  it('splits a .mov (QuickTime/H.264) container into mp3 chunks', async () => {
    const fixture = buildFixture(
      'clip.mov',
      [
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120:rate=10',
        '-t',
        '60',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
      ],
      workDir,
    );
    if (!fixture) {
      console.warn(
        '[audioSplitter codec test] SKIP mov: ffmpeg could not encode the QuickTime fixture',
      );
      return;
    }
    await expectSplitsToMp3(fixture, 256 * 1024);
  }, 60_000);

  // Note: a video-only (no audio stream) input is NOT tested here because
  // splitAudioFile's within-target copy path succeeds by copying bytes — the
  // no-audio detection lives upstream in audioExtractor.hasAudioStream, which
  // FileProcessor calls before splitting. That error path ("does not contain
  // an audio track") is covered by FileProcessor.audio.test.ts.
});

// CI guard: the codec-diversity suite must run on CI where ffmpeg-static is
// installed. A silent skip would leave the m4v/opus/flac paths untested.
it.runIf(process.env.CI)(
  'CI provides ffmpeg with the common decoders (opus/flac/aac)',
  () => {
    expect(canRun).toBe(true);
    // Don't hard-fail if a specific decoder is absent — the individual tests
    // already skip with a warning. But assert the binary at least lists
    // decoders (catches a broken ffmpeg-static install).
    expect(ffmpegHasDecoder('aac')).toBe(true);
  },
);

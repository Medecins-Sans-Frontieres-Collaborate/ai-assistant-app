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
});

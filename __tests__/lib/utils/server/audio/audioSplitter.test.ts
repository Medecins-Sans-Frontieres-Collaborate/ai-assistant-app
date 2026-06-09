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
      jobId: 'audio-splitter-test',
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

    // Chunks must come back in playback order for transcript assembly.
    expect(result.chunkPaths).toEqual([...result.chunkPaths].sort());
  }, 120_000);
});

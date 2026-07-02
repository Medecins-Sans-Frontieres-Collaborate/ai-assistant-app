/**
 * Magic-byte signature validation tests.
 *
 * Both upload entry points (app/api/file/upload/route.ts and
 * lib/actions/fileUpload.ts) hard-reject audio/video uploads whose magic
 * bytes don't validate, so every extension advertised in
 * AUDIO_VIDEO_EXTENSIONS / TRANSCRIPTION_ACCEPT_TYPES must have a matching
 * entry in FILE_SIGNATURES — otherwise the format is "supported" in the
 * picker but fails at upload. These tests feed real format headers through
 * validateBufferSignature (the server-side gate) to lock that invariant.
 */
import { validateBufferSignature } from '@/lib/utils/server/file/fileValidation';

import { describe, expect, it } from 'vitest';

/** Builds a 16-byte buffer starting with the given header bytes. */
function header(...bytes: number[]): Buffer {
  const buf = Buffer.alloc(16);
  Buffer.from(bytes).copy(buf);
  return buf;
}

describe('validateBufferSignature — formats added for transcription', () => {
  it('accepts ADTS AAC (MPEG-4 syncword 0xFF 0xF1)', () => {
    const result = validateBufferSignature(
      header(0xff, 0xf1, 0x50, 0x80, 0x1e, 0x7f, 0xfc),
      'any',
      'voicememo.aac',
    );
    expect(result.isValid).toBe(true);
    expect(result.detectedFormat).toBe('aac');
    expect(result.detectedType).toBe('audio');
    expect(result.confidence).toBe('high');
  });

  it('accepts ADTS AAC (MPEG-2 syncword 0xFF 0xF9)', () => {
    const result = validateBufferSignature(
      header(0xff, 0xf9, 0x50, 0x80),
      'any',
      'voicememo.aac',
    );
    expect(result.isValid).toBe(true);
    expect(result.detectedFormat).toBe('aac');
  });

  it('accepts ADIF AAC', () => {
    const result = validateBufferSignature(
      header(0x41, 0x44, 0x49, 0x46), // "ADIF"
      'any',
      'voicememo.aac',
    );
    expect(result.isValid).toBe(true);
    expect(result.detectedFormat).toBe('aac');
  });

  it('accepts .opus (Ogg container) with high confidence', () => {
    const result = validateBufferSignature(
      header(0x4f, 0x67, 0x67, 0x53), // "OggS"
      'any',
      'voicememo.opus',
    );
    expect(result.isValid).toBe(true);
    expect(result.detectedFormat).toBe('ogg');
    expect(result.detectedType).toBe('audio');
    // .opus is listed on the ogg entry, so the extension matches → high.
    expect(result.confidence).toBe('high');
  });

  it('accepts .3gp (ISO-BMFF ftyp brand) with high confidence', () => {
    const result = validateBufferSignature(
      header(
        0x00,
        0x00,
        0x00,
        0x1c,
        0x66, // f
        0x74, // t
        0x79, // y
        0x70, // p
        0x33, // 3
        0x67, // g
        0x70, // p
        0x34, // 4
      ),
      'any',
      'clip.3gp',
    );
    expect(result.isValid).toBe(true);
    expect(result.detectedFormat).toBe('mp4');
    expect(result.detectedType).toBe('video');
    expect(result.confidence).toBe('high');
  });

  it('does not misread MP3 frame syncs as AAC', () => {
    // 0xFF 0xFB is an MPEG-1 Layer 3 sync — must stay classified as mp3.
    const result = validateBufferSignature(
      header(0xff, 0xfb, 0x90, 0x00),
      'any',
      'song.mp3',
    );
    expect(result.isValid).toBe(true);
    expect(result.detectedFormat).toBe('mp3');
  });

  it('rejects TypeScript source content (no A/V signature)', () => {
    const result = validateBufferSignature(
      Buffer.from("import { x } from './y';"),
      'any',
      'utils.ts',
    );
    expect(result.isValid).toBe(false);
    expect(result.detectedFormat).toBeNull();
  });
});

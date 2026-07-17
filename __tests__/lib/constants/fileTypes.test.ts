import {
  AUDIO_VIDEO_EXTENSIONS,
  TRANSCRIPTION_ACCEPT_TYPES,
  WHISPER_NATIVE_EXTENSIONS,
  isAudioVideoFile,
  isAudioVideoFileByTypeOrName,
  isDocumentTranslatableUpload,
  isWhisperNativeFormat,
} from '@/lib/constants/fileTypes';
import { describe, expect, it } from 'vitest';

describe('isDocumentTranslatableUpload', () => {
  it('accepts a file by its supported extension (no MIME needed)', () => {
    expect(isDocumentTranslatableUpload('report.docx')).toBe(true);
    expect(isDocumentTranslatableUpload('notes.txt', '')).toBe(true);
  });

  it('accepts a file whose extension is missing but MIME type is recognized', () => {
    expect(
      isDocumentTranslatableUpload(
        'report',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
  });

  it('normalizes a MIME type with a charset parameter', () => {
    expect(
      isDocumentTranslatableUpload('data', 'text/csv; charset=utf-8'),
    ).toBe(true);
  });

  it('rejects an unrecognized extension with no usable MIME type', () => {
    expect(isDocumentTranslatableUpload('archive.zip')).toBe(false);
    expect(
      isDocumentTranslatableUpload('archive.zip', 'application/octet-stream'),
    ).toBe(false);
    expect(isDocumentTranslatableUpload('archive.zip', null)).toBe(false);
  });
});

// Regression coverage for issue #90: .m4v (and several other containers)
// were missing from the transcription allowlist, so an uploaded .m4v was
// routed to the document branch and surfaced a generic "unable to process"
// error. These tests lock the allowlist so a format can't silently disappear.
describe('AUDIO_VIDEO_EXTENSIONS / isAudioVideoFile', () => {
  // Every extension that must be accepted for transcription.
  const expectedExtensions = [
    '.mp3',
    '.mp4',
    '.mpeg',
    '.mpga',
    '.m4a',
    '.wav',
    '.webm',
    '.m4v',
    '.mkv',
    '.mov',
    '.avi',
    '.flv',
    '.wmv',
    '.ogg',
    '.oga',
    '.flac',
    '.aac',
    '.opus',
    '.3gp',
    '.mpg',
    '.wma',
  ];

  it('includes every documented transcribable extension', () => {
    for (const ext of expectedExtensions) {
      expect(AUDIO_VIDEO_EXTENSIONS, `missing ${ext}`).toContain(ext);
    }
  });

  it('isAudioVideoFile returns true for every documented extension', () => {
    for (const ext of expectedExtensions) {
      expect(isAudioVideoFile(`clip${ext}`), `expected true for ${ext}`).toBe(
        true,
      );
    }
  });

  it('isAudioVideoFile is case-insensitive', () => {
    expect(isAudioVideoFile('CLIP.M4V')).toBe(true);
    expect(isAudioVideoFile('Clip.Ogg')).toBe(true);
  });

  it('isAudioVideoFile rejects unknown extensions and extension-less names', () => {
    expect(isAudioVideoFile('archive.zip')).toBe(false);
    expect(isAudioVideoFile('readme')).toBe(false);
    expect(isAudioVideoFile('')).toBe(false);
    expect(isAudioVideoFile('noextension')).toBe(false);
  });

  // `.ts` collides with TypeScript source files, which are supported code
  // uploads (DOCUMENT_AND_CODE_ACCEPT_TYPES). It must never be classified
  // as audio/video by extension, or code files get routed into the
  // transcription pipeline and break.
  it('does NOT classify .ts (TypeScript) as audio/video', () => {
    expect(AUDIO_VIDEO_EXTENSIONS).not.toContain('.ts');
    expect(isAudioVideoFile('utils.ts')).toBe(false);
    expect(isAudioVideoFileByTypeOrName('utils.ts')).toBe(false);
    expect(TRANSCRIPTION_ACCEPT_TYPES).not.toMatch(/\.ts(,|$)/);
  });

  it('explicitly includes .m4v (the issue #90 regression)', () => {
    expect(AUDIO_VIDEO_EXTENSIONS).toContain('.m4v');
    expect(isAudioVideoFile('recording.m4v')).toBe(true);
  });
});

describe('WHISPER_NATIVE_EXTENSIONS / isWhisperNativeFormat', () => {
  // Per OpenAI docs: mp3, mp4, mpeg, mpga, m4a, wav, webm.
  it('lists exactly the formats Whisper accepts natively', () => {
    expect([...WHISPER_NATIVE_EXTENSIONS].sort()).toEqual(
      ['.mp3', '.mp4', '.m4a', '.mpeg', '.mpga', '.wav', '.webm'].sort(),
    );
  });

  it('isWhisperNativeFormat returns true for Whisper-native formats', () => {
    for (const ext of WHISPER_NATIVE_EXTENSIONS) {
      expect(
        isWhisperNativeFormat(`audio${ext}`),
        `expected true for ${ext}`,
      ).toBe(true);
    }
  });

  it('isWhisperNativeFormat returns false for formats that need transcoding', () => {
    // These are accepted for transcription but Whisper can't read them directly.
    const needsTranscoding = [
      '.m4v',
      '.mkv',
      '.mov',
      '.avi',
      '.flv',
      '.wmv',
      '.ogg',
      '.oga',
      '.flac',
      '.aac',
      '.opus',
      '.3gp',
      '.mpg',
      '.wma',
    ];
    for (const ext of needsTranscoding) {
      expect(
        isWhisperNativeFormat(`clip${ext}`),
        `expected false for ${ext}`,
      ).toBe(false);
    }
  });

  it('isWhisperNativeFormat is case-insensitive and handles edge cases', () => {
    expect(isWhisperNativeFormat('AUDIO.MP3')).toBe(true);
    expect(isWhisperNativeFormat('')).toBe(false);
    expect(isWhisperNativeFormat('noext')).toBe(false);
  });
});

describe('isAudioVideoFileByTypeOrName', () => {
  it('accepts by audio/ MIME regardless of extension', () => {
    expect(isAudioVideoFileByTypeOrName('blob', 'audio/ogg')).toBe(true);
    expect(isAudioVideoFileByTypeOrName('blob', 'video/x-m4v')).toBe(true);
  });

  it('falls back to extension when MIME is absent or non-media', () => {
    expect(isAudioVideoFileByTypeOrName('clip.m4v')).toBe(true);
    expect(isAudioVideoFileByTypeOrName('clip.m4v', '')).toBe(true);
    expect(
      isAudioVideoFileByTypeOrName('clip.m4v', 'application/octet-stream'),
    ).toBe(true);
  });

  it('rejects non-media files with no media MIME', () => {
    expect(isAudioVideoFileByTypeOrName('doc.pdf')).toBe(false);
    expect(isAudioVideoFileByTypeOrName('archive.zip', 'application/zip')).toBe(
      false,
    );
  });
});

describe('TRANSCRIPTION_ACCEPT_TYPES', () => {
  it('contains every extension in AUDIO_VIDEO_EXTENSIONS', () => {
    for (const ext of AUDIO_VIDEO_EXTENSIONS) {
      expect(
        TRANSCRIPTION_ACCEPT_TYPES,
        `TRANSCRIPTION_ACCEPT_TYPES missing ${ext}`,
      ).toContain(ext);
    }
  });

  it('explicitly includes .m4v', () => {
    expect(TRANSCRIPTION_ACCEPT_TYPES).toContain('.m4v');
  });
});

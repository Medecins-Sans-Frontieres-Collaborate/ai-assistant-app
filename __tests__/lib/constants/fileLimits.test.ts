import {
  CONTENT_LIMITS,
  FILE_SIZE_LIMITS,
  FILE_SIZE_LIMITS_DISPLAY,
} from '@/lib/utils/app/const';

import {
  type FileCategory,
  getContentLimit,
  getFileCategory,
  getFileSizeLimit,
  getFileSizeLimitDisplay,
  getMaxSizeForFile,
  requiresContentValidation,
  validateDocumentContent,
  validateFileSize,
  validateFileSizeRaw,
} from '@/lib/constants/fileLimits';
import { describe, expect, it } from 'vitest';

describe('fileLimits', () => {
  describe('getFileCategory', () => {
    it('should detect image files by extension', () => {
      expect(getFileCategory('photo.jpg')).toBe('image');
      expect(getFileCategory('photo.jpeg')).toBe('image');
      expect(getFileCategory('image.png')).toBe('image');
      expect(getFileCategory('animation.gif')).toBe('image');
      expect(getFileCategory('icon.webp')).toBe('image');
      expect(getFileCategory('logo.svg')).toBe('image');
    });

    it('should detect audio files by extension', () => {
      expect(getFileCategory('song.mp3')).toBe('audio');
      expect(getFileCategory('audio.m4a')).toBe('audio');
      expect(getFileCategory('sound.wav')).toBe('audio');
      expect(getFileCategory('music.ogg')).toBe('audio');
      expect(getFileCategory('recording.flac')).toBe('audio');
    });

    it('should detect video files by extension', () => {
      expect(getFileCategory('movie.mp4')).toBe('video');
      expect(getFileCategory('clip.mkv')).toBe('video');
      expect(getFileCategory('video.mov')).toBe('video');
      expect(getFileCategory('film.avi')).toBe('video');
      expect(getFileCategory('stream.webm')).toBe('video');
    });

    // Regression for issue #90: .m4v was missing from VIDEO_EXTENSIONS, so a
    // .m4v with no MIME type fell into 'unknown' and got the 50MB document cap
    // instead of the 1.5GB video cap — silently rejecting large recordings.
    it('categorizes .m4v as video (with and without MIME type)', () => {
      expect(getFileCategory('clip.m4v')).toBe('video');
      expect(getFileCategory('clip.m4v', 'video/x-m4v')).toBe('video');
      expect(getFileCategory('clip.m4v', '')).toBe('video');
    });

    it('categorizes the newly added audio containers as audio', () => {
      expect(getFileCategory('song.ogg')).toBe('audio');
      expect(getFileCategory('song.oga')).toBe('audio');
      expect(getFileCategory('recording.flac')).toBe('audio');
      expect(getFileCategory('clip.aac')).toBe('audio');
      expect(getFileCategory('clip.opus')).toBe('audio');
      expect(getFileCategory('song.wma')).toBe('audio');
    });

    it('categorizes the newly added video containers as video', () => {
      expect(getFileCategory('clip.3gp')).toBe('video');
      expect(getFileCategory('movie.mpg')).toBe('video');
    });

    // `.ts` is TypeScript, not MPEG-TS, from this app's perspective — it must
    // never be categorized as video or code uploads inherit the video cap and
    // A/V routing.
    it('does NOT categorize .ts as video', () => {
      expect(getFileCategory('utils.ts')).toBe('unknown');
    });

    it('should detect document files by extension', () => {
      expect(getFileCategory('document.pdf')).toBe('document');
      expect(getFileCategory('file.doc')).toBe('document');
      expect(getFileCategory('report.docx')).toBe('document');
      expect(getFileCategory('data.txt')).toBe('document');
      expect(getFileCategory('readme.md')).toBe('document');
      expect(getFileCategory('book.epub')).toBe('document');
      expect(getFileCategory('spreadsheet.xlsx')).toBe('document');
    });

    it('should return unknown for unrecognized extensions', () => {
      expect(getFileCategory('file.xyz')).toBe('unknown');
      expect(getFileCategory('noextension')).toBe('unknown');
      expect(getFileCategory('')).toBe('unknown');
    });

    it('should use MIME type over extension when provided', () => {
      // MIME type takes precedence
      expect(getFileCategory('file.txt', 'image/png')).toBe('image');
      expect(getFileCategory('file.txt', 'audio/mpeg')).toBe('audio');
      expect(getFileCategory('file.txt', 'video/mp4')).toBe('video');
    });

    it('should handle .webm as audio when MIME type specifies audio', () => {
      expect(getFileCategory('media.webm', 'audio/webm')).toBe('audio');
      expect(getFileCategory('media.webm', 'video/webm')).toBe('video');
      // Default to video when no MIME type (extension-based)
      expect(getFileCategory('media.webm')).toBe('video');
    });

    it('should be case insensitive for extensions', () => {
      expect(getFileCategory('photo.JPG')).toBe('image');
      expect(getFileCategory('photo.JPEG')).toBe('image');
      expect(getFileCategory('document.PDF')).toBe('document');
      expect(getFileCategory('song.MP3')).toBe('audio');
      expect(getFileCategory('clip.M4V')).toBe('video');
      expect(getFileCategory('clip.OGG')).toBe('audio');
    });
  });

  describe('getFileSizeLimit', () => {
    it('should return correct limits for each category', () => {
      expect(getFileSizeLimit('image')).toBe(FILE_SIZE_LIMITS.IMAGE_MAX_BYTES);
      expect(getFileSizeLimit('audio')).toBe(FILE_SIZE_LIMITS.AUDIO_MAX_BYTES);
      expect(getFileSizeLimit('video')).toBe(FILE_SIZE_LIMITS.VIDEO_MAX_BYTES);
      expect(getFileSizeLimit('document')).toBe(
        FILE_SIZE_LIMITS.DOCUMENT_MAX_BYTES,
      );
      expect(getFileSizeLimit('unknown')).toBe(
        FILE_SIZE_LIMITS.DOCUMENT_MAX_BYTES,
      );
    });

    it('should have expected byte values', () => {
      expect(getFileSizeLimit('image')).toBe(5 * 1024 * 1024); // 5MB
      expect(getFileSizeLimit('audio')).toBe(1024 * 1024 * 1024); // 1GB
      expect(getFileSizeLimit('video')).toBe(1.5 * 1024 * 1024 * 1024); // 1.5GB
      expect(getFileSizeLimit('document')).toBe(50 * 1024 * 1024); // 50MB
    });
  });

  describe('getFileSizeLimitDisplay', () => {
    it('should return human-readable strings', () => {
      expect(getFileSizeLimitDisplay('image')).toBe('5MB');
      expect(getFileSizeLimitDisplay('audio')).toBe('1GB');
      expect(getFileSizeLimitDisplay('video')).toBe('1.5GB');
      expect(getFileSizeLimitDisplay('document')).toBe('50MB');
    });
  });

  describe('FILE_SIZE_LIMITS_DISPLAY', () => {
    it('should have dynamically generated display strings', () => {
      expect(FILE_SIZE_LIMITS_DISPLAY.IMAGE).toBe('5MB');
      expect(FILE_SIZE_LIMITS_DISPLAY.AUDIO).toBe('1GB');
      expect(FILE_SIZE_LIMITS_DISPLAY.VIDEO).toBe('1.5GB');
      expect(FILE_SIZE_LIMITS_DISPLAY.DOCUMENT).toBe('50MB');
      expect(FILE_SIZE_LIMITS_DISPLAY.PDF_PAGES).toBe('500 pages');
      expect(FILE_SIZE_LIMITS_DISPLAY.TEXT_CHARS).toBe('400K characters');
    });
  });

  describe('requiresContentValidation', () => {
    it('should return true for PDF files', () => {
      expect(requiresContentValidation('document.pdf')).toBe(true);
      expect(requiresContentValidation('report.PDF')).toBe(true);
    });

    it('should return true for text-based files', () => {
      expect(requiresContentValidation('file.txt')).toBe(true);
      expect(requiresContentValidation('readme.md')).toBe(true);
      expect(requiresContentValidation('data.json')).toBe(true);
      expect(requiresContentValidation('config.xml')).toBe(true);
      expect(requiresContentValidation('data.csv')).toBe(true);
      expect(requiresContentValidation('book.epub')).toBe(true);
    });

    it('should return false for non-text files', () => {
      expect(requiresContentValidation('photo.jpg')).toBe(false);
      expect(requiresContentValidation('song.mp3')).toBe(false);
      expect(requiresContentValidation('video.mp4')).toBe(false);
      expect(requiresContentValidation('document.docx')).toBe(false);
      expect(requiresContentValidation('spreadsheet.xlsx')).toBe(false);
    });
  });

  describe('getContentLimit', () => {
    it('should return page limit for PDF files', () => {
      const limit = getContentLimit('document.pdf');
      expect(limit).not.toBeNull();
      expect(limit!.type).toBe('pages');
      expect(limit!.limit).toBe(CONTENT_LIMITS.PDF_MAX_PAGES);
      expect(limit!.display).toBe('500 pages');
    });

    it('should return character limit for text files', () => {
      const limit = getContentLimit('file.txt');
      expect(limit).not.toBeNull();
      expect(limit!.type).toBe('characters');
      expect(limit!.limit).toBe(CONTENT_LIMITS.TEXT_MAX_CHARACTERS);
      expect(limit!.display).toContain('400K characters');
      expect(limit!.display).toContain('tokens');
    });

    it('should return null for non-text files', () => {
      expect(getContentLimit('photo.jpg')).toBeNull();
      expect(getContentLimit('song.mp3')).toBeNull();
      expect(getContentLimit('video.mp4')).toBeNull();
    });
  });

  describe('validateFileSize', () => {
    it('should validate files within size limits', () => {
      const smallImage = new File(['x'.repeat(1024 * 1024)], 'small.jpg', {
        type: 'image/jpeg',
      });
      const result = validateFileSize(smallImage);
      expect(result.valid).toBe(true);
      expect(result.category).toBe('image');
    });

    it('should reject files exceeding size limits', () => {
      // Create a file that's larger than 5MB (image limit)
      const largeImage = new File(['x'.repeat(6 * 1024 * 1024)], 'large.jpg', {
        type: 'image/jpeg',
      });
      const result = validateFileSize(largeImage);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Image');
      expect(result.error).toContain('5MB');
    });
  });

  describe('validateFileSizeRaw', () => {
    it('should validate raw file size values', () => {
      const result = validateFileSizeRaw(
        'small.jpg',
        1024 * 1024,
        'image/jpeg',
      );
      expect(result.valid).toBe(true);
      expect(result.category).toBe('image');
    });

    it('should reject files exceeding limits', () => {
      const result = validateFileSizeRaw(
        'large.jpg',
        10 * 1024 * 1024,
        'image/jpeg',
      );
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Image');
    });

    it('should use correct limits for each file type', () => {
      // Image: 5MB limit
      expect(validateFileSizeRaw('img.png', 4 * 1024 * 1024).valid).toBe(true);
      expect(validateFileSizeRaw('img.png', 6 * 1024 * 1024).valid).toBe(false);

      // Audio: 1GB limit
      expect(validateFileSizeRaw('audio.mp3', 500 * 1024 * 1024).valid).toBe(
        true,
      );
      expect(
        validateFileSizeRaw('audio.mp3', 1.5 * 1024 * 1024 * 1024).valid,
      ).toBe(false);

      // Video: 1.5GB limit
      expect(validateFileSizeRaw('video.mp4', 1024 * 1024 * 1024).valid).toBe(
        true,
      );
      expect(
        validateFileSizeRaw('video.mp4', 2 * 1024 * 1024 * 1024).valid,
      ).toBe(false);

      // Document: 50MB limit
      expect(validateFileSizeRaw('doc.pdf', 40 * 1024 * 1024).valid).toBe(true);
      expect(validateFileSizeRaw('doc.pdf', 60 * 1024 * 1024).valid).toBe(
        false,
      );
    });

    // Regression lock for issue #90: an .m4v must use the video cap (1.5GB),
    // NOT the 50MB document cap that 'unknown' files fall back to. Without
    // this assertion a future regression that drops .m4v from VIDEO_EXTENSIONS
    // would silently reject legitimate recordings again.
    it('applies the video (1.5GB) size cap to .m4v, not the document cap', () => {
      // A 200MB m4v must be valid (would be rejected under the 50MB doc cap).
      const result = validateFileSizeRaw('clip.m4v', 200 * 1024 * 1024);
      expect(result.valid).toBe(true);
      expect(result.category).toBe('video');

      // And an .m4v over 1.5GB must still be rejected.
      const tooLarge = validateFileSizeRaw(
        'clip.m4v',
        1.6 * 1024 * 1024 * 1024,
      );
      expect(tooLarge.valid).toBe(false);
      expect(tooLarge.category).toBe('video');
    });

    it('applies the audio (1GB) cap to the newly added audio containers', () => {
      for (const ext of ['.ogg', '.oga', '.flac', '.aac', '.opus', '.wma']) {
        const result = validateFileSizeRaw(`song${ext}`, 500 * 1024 * 1024);
        expect(result.valid, `expected valid for ${ext}`).toBe(true);
        expect(result.category, `expected audio for ${ext}`).toBe('audio');
      }
    });
  });

  describe('validateDocumentContent', () => {
    it('should validate PDF page count', () => {
      const validResult = validateDocumentContent('doc.pdf', '', 100);
      expect(validResult.valid).toBe(true);

      const invalidResult = validateDocumentContent('doc.pdf', '', 600);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.error).toContain('500 pages');
      expect(invalidResult.error).toContain('600 pages');
    });

    it('should validate text character count', () => {
      const shortText = 'x'.repeat(100000);
      const validResult = validateDocumentContent('file.txt', shortText);
      expect(validResult.valid).toBe(true);

      const longText = 'x'.repeat(500000);
      const invalidResult = validateDocumentContent('file.txt', longText);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.error).toContain('400K characters');
    });

    it('should pass validation for non-text files', () => {
      const result = validateDocumentContent('photo.jpg', 'any content');
      expect(result.valid).toBe(true);
    });
  });

  describe('getMaxSizeForFile', () => {
    it('should return bytes and display string for File objects', () => {
      const imageFile = new File([''], 'photo.jpg', { type: 'image/jpeg' });
      const imageResult = getMaxSizeForFile(imageFile);
      expect(imageResult.bytes).toBe(5 * 1024 * 1024);
      expect(imageResult.display).toBe('5MB');

      const audioFile = new File([''], 'song.mp3', { type: 'audio/mpeg' });
      const audioResult = getMaxSizeForFile(audioFile);
      expect(audioResult.bytes).toBe(1024 * 1024 * 1024);
      expect(audioResult.display).toBe('1GB');
    });
  });
});

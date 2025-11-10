import { describe, expect, it, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { onFileUpload } from '@/components/Chat/ChatInputEventHandlers/file-upload';

// Mock dependencies
vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/components/Chat/ChatInputEventHandlers/image-upload', () => ({
  onImageUpload: vi.fn(),
}));

describe('file-upload validation', () => {
  let setSubmitType: ReturnType<typeof vi.fn>;
  let setFilePreviews: ReturnType<typeof vi.fn>;
  let setFileFieldValue: ReturnType<typeof vi.fn>;
  let setImageFieldValue: ReturnType<typeof vi.fn>;
  let setUploadProgress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setSubmitType = vi.fn();
    setFilePreviews = vi.fn((fn) => {
      if (typeof fn === 'function') {
        return fn([]);
      }
    });
    setFileFieldValue = vi.fn();
    setImageFieldValue = vi.fn();
    setUploadProgress = vi.fn();
    vi.clearAllMocks();
  });

  describe('Disallowed File Extensions', () => {
    it('rejects .exe files', async () => {
      const file = new File(['content'], 'malware.exe', { type: 'application/x-msdownload' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type provided: malware.exe')
      );
    });

    it('rejects .dll files', async () => {
      const file = new File(['content'], 'library.dll', { type: 'application/octet-stream' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type provided: library.dll')
      );
    });

    it('rejects .zip archives', async () => {
      const file = new File(['content'], 'archive.zip', { type: 'application/zip' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type provided: archive.zip')
      );
    });

    it('rejects .rar archives', async () => {
      const file = new File(['content'], 'archive.rar', { type: 'application/x-rar-compressed' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type provided: archive.rar')
      );
    });

    it('rejects .7z archives', async () => {
      const file = new File(['content'], 'archive.7z', { type: 'application/x-7z-compressed' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type provided: archive.7z')
      );
    });

    it('rejects .iso files', async () => {
      const file = new File(['content'], 'disk.iso', { type: 'application/x-iso9660-image' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type provided: disk.iso')
      );
    });
  });

  describe('Unsupported Media Files', () => {
    it('rejects .mp3 audio files', async () => {
      const file = new File(['content'], 'song.mp3', { type: 'audio/mpeg' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('This file type is currently unsupported: song.mp3')
      );
    });

    it('rejects .wav audio files', async () => {
      const file = new File(['content'], 'audio.wav', { type: 'audio/wav' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('This file type is currently unsupported: audio.wav')
      );
    });

    it('rejects .mp4 video files', async () => {
      const file = new File(['content'], 'video.mp4', { type: 'video/mp4' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('This file type is currently unsupported: video.mp4')
      );
    });

    it('rejects .avi video files', async () => {
      const file = new File(['content'], 'video.avi', { type: 'video/x-msvideo' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('This file type is currently unsupported: video.avi')
      );
    });

    it('rejects .mov video files', async () => {
      const file = new File(['content'], 'video.mov', { type: 'video/quicktime' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('This file type is currently unsupported: video.mov')
      );
    });

    it('rejects files with audio/* mime type', async () => {
      const file = new File(['content'], 'audio.ogg', { type: 'audio/ogg' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('This file type is currently unsupported: audio.ogg')
      );
    });

    it('rejects files with video/* mime type', async () => {
      const file = new File(['content'], 'video.webm', { type: 'video/webm' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('This file type is currently unsupported: video.webm')
      );
    });
  });

  describe('File Size Limits', () => {
    it('rejects files larger than 10MB', async () => {
      // Create a file larger than 10MB (10485760 bytes)
      const largeContent = 'x'.repeat(10485761);
      const largeFile = new File([largeContent], 'huge.pdf', { type: 'application/pdf' });

      await onFileUpload(
        [largeFile],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        'File huge.pdf must be less than 10MB.'
      );
    });

    it('accepts files exactly at 10MB limit', async () => {
      const content = 'x'.repeat(10485760); // Exactly 10MB
      const file = new File([content], 'exact10mb.pdf', { type: 'application/pdf' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('must be less than 10MB')
      );
    });

    it('accepts small files', async () => {
      const file = new File(['small content'], 'small.txt', { type: 'text/plain' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('must be less than 10MB')
      );
    });
  });

  describe('File Count Limits', () => {
    it('rejects when no files selected', async () => {
      await onFileUpload(
        [],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith('No files selected.');
    });

    it('rejects more than 5 files', async () => {
      const files = Array.from({ length: 6 }, (_, i) =>
        new File(['content'], `file${i}.txt`, { type: 'text/plain' })
      );

      await onFileUpload(
        files,
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        'You can upload a maximum of 5 files at a time.'
      );
    });

    it('accepts 1 file', async () => {
      const file = new File(['content'], 'file.txt', { type: 'text/plain' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('maximum of 5 files')
      );
    });

    it('accepts 5 files', async () => {
      const files = Array.from({ length: 5 }, (_, i) =>
        new File(['content'], `file${i}.txt`, { type: 'text/plain' })
      );

      await onFileUpload(
        files,
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('maximum of 5 files')
      );
    });
  });

  describe('Allowed File Types', () => {
    it('accepts .pdf files', async () => {
      const file = new File(['content'], 'document.pdf', { type: 'application/pdf' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type')
      );
    });

    it('accepts .txt files', async () => {
      const file = new File(['content'], 'notes.txt', { type: 'text/plain' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type')
      );
    });

    it('accepts .docx files', async () => {
      const file = new File(['content'], 'document.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type')
      );
    });

    it('accepts .csv files', async () => {
      const file = new File(['content'], 'data.csv', { type: 'text/csv' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type')
      );
    });

    it('accepts .json files', async () => {
      const file = new File(['content'], 'data.json', { type: 'application/json' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type')
      );
    });
  });

  describe('Edge Cases', () => {
    it('handles file with uppercase extension', async () => {
      const file = new File(['content'], 'DOCUMENT.PDF', { type: 'application/pdf' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
    });

    it('handles file with mixed case extension', async () => {
      const file = new File(['content'], 'Document.PdF', { type: 'application/pdf' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
    });

    it('handles file with multiple dots in name', async () => {
      const file = new File(['content'], 'my.file.name.with.dots.txt', { type: 'text/plain' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
    });

    it('handles file with no extension', async () => {
      const file = new File(['content'], 'noextension', { type: 'text/plain' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
    });

    it('rejects disallowed files regardless of mime type mismatch', async () => {
      // File with .exe extension but wrong mime type
      const file = new File(['content'], 'malware.exe', { type: 'text/plain' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type provided: malware.exe')
      );
    });

    it('validates all files in batch', async () => {
      const files = [
        new File(['content'], 'valid.txt', { type: 'text/plain' }),
        new File(['content'], 'invalid.exe', { type: 'application/x-msdownload' }),
        new File(['content'], 'also-valid.pdf', { type: 'application/pdf' }),
      ];

      await onFileUpload(
        files,
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      // Should have error for the invalid file
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type provided: invalid.exe')
      );
    });
  });
});

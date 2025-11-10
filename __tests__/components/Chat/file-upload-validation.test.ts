import toast from 'react-hot-toast';

import { FileUploadService } from '@/client/services/fileUploadService';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock FileUploadService
vi.mock('@/client/services/fileUploadService', () => ({
  FileUploadService: {
    uploadMultipleFiles: vi.fn(),
  },
}));

describe('file-upload validation', () => {
  let setSubmitType: ReturnType<typeof vi.fn>;
  let setFilePreviews: ReturnType<typeof vi.fn>;
  let setFileFieldValue: ReturnType<typeof vi.fn>;
  let setImageFieldValue: ReturnType<typeof vi.fn>;
  let setUploadProgress: ReturnType<typeof vi.fn>;

  // Disallowed extensions (from FileUploadService)
  const disallowedExtensions = [
    '.exe',
    '.dll',
    '.bat',
    '.cmd',
    '.sh',
    '.app',
    '.deb',
    '.rpm',
    '.zip',
    '.rar',
    '.7z',
    '.tar',
    '.gz',
    '.iso',
    '.dmg',
    '.pkg',
  ];

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

    // Mock FileUploadService.uploadMultipleFiles to simulate real validation behavior
    vi.mocked(FileUploadService.uploadMultipleFiles).mockImplementation(
      async (files) => {
        const results = [];

        for (const file of files) {
          const ext = '.' + file.name.split('.').pop()?.toLowerCase();

          // Check if file extension is disallowed
          if (disallowedExtensions.includes(ext)) {
            toast.error(`Invalid file type: ${file.name}`);
            continue;
          }

          // Check file size (10MB for documents, 4MB for images)
          const maxSize = file.type.startsWith('image/')
            ? 4 * 1024 * 1024
            : 10 * 1024 * 1024;
          const maxSizeMB = file.type.startsWith('image/') ? 4 : 10;

          if (file.size > maxSize) {
            toast.error(`${file.name} must be less than ${maxSizeMB}MB`);
            continue;
          }

          // Mock successful upload for valid files
          const result = {
            url: `https://example.com/${file.name}`,
            originalFilename: file.name,
            type: file.type.startsWith('image/')
              ? ('image' as const)
              : ('file' as const),
          };
          results.push(result);
        }

        return results;
      },
    );
  });

  describe('Disallowed File Extensions', () => {
    it('rejects .exe files', async () => {
      const file = new File(['content'], 'malware.exe', {
        type: 'application/x-msdownload',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type: malware.exe'),
      );
    });

    it('rejects .dll files', async () => {
      const file = new File(['content'], 'library.dll', {
        type: 'application/octet-stream',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type: library.dll'),
      );
    });

    it('rejects .zip archives', async () => {
      const file = new File(['content'], 'archive.zip', {
        type: 'application/zip',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type: archive.zip'),
      );
    });

    it('rejects .rar archives', async () => {
      const file = new File(['content'], 'archive.rar', {
        type: 'application/x-rar-compressed',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type: archive.rar'),
      );
    });

    it('rejects .7z archives', async () => {
      const file = new File(['content'], 'archive.7z', {
        type: 'application/x-7z-compressed',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type: archive.7z'),
      );
    });

    it('rejects .iso files', async () => {
      const file = new File(['content'], 'disk.iso', {
        type: 'application/x-iso9660-image',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid file type: disk.iso'),
      );
    });
  });

  describe('Audio/Video File Rejection (Use Transcription Button)', () => {
    const audioVideoErrorMessage =
      'Audio/video files cannot be attached. Use the "Transcribe Audio/Video" button in the dropdown menu instead.';

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

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
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

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
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

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
    });

    it('rejects .avi video files', async () => {
      const file = new File(['content'], 'video.avi', {
        type: 'video/x-msvideo',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
    });

    it('rejects .mov video files', async () => {
      const file = new File(['content'], 'video.mov', {
        type: 'video/quicktime',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
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

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
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

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
    });

    it('rejects .m4a audio files by extension', async () => {
      const file = new File(['content'], 'audio.m4a', { type: 'audio/mp4' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
    });

    it('rejects .mpeg video files by extension', async () => {
      const file = new File(['content'], 'video.mpeg', { type: 'video/mpeg' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
    });

    it('rejects .mpga audio files by extension', async () => {
      const file = new File(['content'], 'audio.mpga', { type: 'audio/mpeg' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(audioVideoErrorMessage);
    });
  });

  describe('File Size Limits', () => {
    it('rejects files larger than 10MB', async () => {
      // Create a file larger than 10MB (10485760 bytes)
      const largeContent = 'x'.repeat(10485761);
      const largeFile = new File([largeContent], 'huge.pdf', {
        type: 'application/pdf',
      });

      await onFileUpload(
        [largeFile],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        'huge.pdf must be less than 10MB',
      );
    });

    it('accepts files exactly at 10MB limit', async () => {
      const content = 'x'.repeat(10485760); // Exactly 10MB
      const file = new File([content], 'exact10mb.pdf', {
        type: 'application/pdf',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('must be less than 10MB'),
      );
    });

    it('accepts small files', async () => {
      const file = new File(['small content'], 'small.txt', {
        type: 'text/plain',
      });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('must be less than 10MB'),
      );
    });

    it('rejects images larger than 4MB', async () => {
      // Create image larger than 4MB (4194304 bytes)
      const largeContent = 'x'.repeat(4194305);
      const largeImage = new File([largeContent], 'large-photo.jpg', {
        type: 'image/jpeg',
      });

      await onFileUpload(
        [largeImage],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        'large-photo.jpg must be less than 4MB',
      );
    });

    it('accepts images exactly at 4MB limit', async () => {
      const content = 'x'.repeat(4194304); // Exactly 4MB
      const image = new File([content], 'exact4mb.png', { type: 'image/png' });

      await onFileUpload(
        [image],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).not.toHaveBeenCalledWith(
        expect.stringContaining('must be less than 4MB'),
      );
    });

    it('rejects images just over 4MB limit', async () => {
      const content = 'x'.repeat(4194305); // 1 byte over 4MB
      const image = new File([content], 'over4mb.jpg', { type: 'image/jpeg' });

      await onFileUpload(
        [image],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(toast.error).toHaveBeenCalledWith(
        'over4mb.jpg must be less than 4MB',
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
      const files = Array.from(
        { length: 6 },
        (_, i) => new File(['content'], `file${i}.txt`, { type: 'text/plain' }),
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
        'You can upload a maximum of 5 files at a time.',
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
        expect.stringContaining('maximum of 5 files'),
      );
    });

    it('accepts 5 files', async () => {
      const files = Array.from(
        { length: 5 },
        (_, i) => new File(['content'], `file${i}.txt`, { type: 'text/plain' }),
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
        expect.stringContaining('maximum of 5 files'),
      );
    });
  });

  describe('Allowed File Types', () => {
    it('accepts .pdf files', async () => {
      const file = new File(['content'], 'document.pdf', {
        type: 'application/pdf',
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
        expect.stringContaining('Invalid file type'),
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
        expect.stringContaining('Invalid file type'),
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
        expect.stringContaining('Invalid file type'),
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
        expect.stringContaining('Invalid file type'),
      );
    });

    it('accepts .json files', async () => {
      const file = new File(['content'], 'data.json', {
        type: 'application/json',
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
        expect.stringContaining('Invalid file type'),
      );
    });
  });

  describe('Edge Cases', () => {
    it('handles file with uppercase extension', async () => {
      const file = new File(['content'], 'DOCUMENT.PDF', {
        type: 'application/pdf',
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
    });

    it('handles file with mixed case extension', async () => {
      const file = new File(['content'], 'Document.PdF', {
        type: 'application/pdf',
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
    });

    it('handles file with multiple dots in name', async () => {
      const file = new File(['content'], 'my.file.name.with.dots.txt', {
        type: 'text/plain',
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
        expect.stringContaining('Invalid file type: malware.exe'),
      );
    });

    it('validates all files in batch', async () => {
      const files = [
        new File(['content'], 'valid.txt', { type: 'text/plain' }),
        new File(['content'], 'invalid.exe', {
          type: 'application/x-msdownload',
        }),
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
        expect.stringContaining('Invalid file type: invalid.exe'),
      );
    });

    it('handles mixed images and documents together', async () => {
      const files = [
        new File(['image content'], 'photo.jpg', { type: 'image/jpeg' }),
        new File(['doc content'], 'document.pdf', { type: 'application/pdf' }),
        new File(['spreadsheet'], 'data.xlsx', {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
      ];

      await onFileUpload(
        files,
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      // Should accept all mixed files
      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();

      // Should set submit type to multi-file
      expect(setSubmitType).toHaveBeenCalled();
    });

    it('rejects batch if ANY file is audio/video', async () => {
      const files = [
        new File(['image'], 'photo.jpg', { type: 'image/jpeg' }),
        new File(['doc'], 'document.pdf', { type: 'application/pdf' }),
        new File(['audio'], 'song.mp3', { type: 'audio/mpeg' }), // Invalid!
      ];

      await onFileUpload(
        files,
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      // Should reject entire batch due to audio file
      expect(toast.error).toHaveBeenCalledWith(
        'Audio/video files cannot be attached. Use the "Transcribe Audio/Video" button in the dropdown menu instead.',
      );

      // Should not proceed with upload
      expect(setFilePreviews).not.toHaveBeenCalled();
    });

    it('handles multiple images only', async () => {
      const files = [
        new File(['image1'], 'photo1.jpg', { type: 'image/jpeg' }),
        new File(['image2'], 'photo2.png', { type: 'image/png' }),
        new File(['image3'], 'photo3.gif', { type: 'image/gif' }),
      ];

      await onFileUpload(
        files,
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      // Should accept multiple images
      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('handles multiple documents only', async () => {
      const files = [
        new File(['doc1'], 'file1.pdf', { type: 'application/pdf' }),
        new File(['doc2'], 'file2.docx', {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        }),
        new File(['doc3'], 'file3.txt', { type: 'text/plain' }),
      ];

      await onFileUpload(
        files,
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      // Should accept multiple documents
      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  describe('Image Format Support', () => {
    it('accepts JPEG images', async () => {
      const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('accepts PNG images', async () => {
      const file = new File(['image'], 'graphic.png', { type: 'image/png' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('accepts GIF images', async () => {
      const file = new File(['image'], 'animation.gif', { type: 'image/gif' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('accepts WEBP images', async () => {
      const file = new File(['image'], 'modern.webp', { type: 'image/webp' });

      await onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('accepts SVG images', async () => {
      const file = new File(['<svg></svg>'], 'vector.svg', {
        type: 'image/svg+xml',
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
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('accepts images with mixed formats in batch', async () => {
      const files = [
        new File(['image1'], 'photo.jpg', { type: 'image/jpeg' }),
        new File(['image2'], 'graphic.png', { type: 'image/png' }),
        new File(['image3'], 'animation.gif', { type: 'image/gif' }),
        new File(['image4'], 'modern.webp', { type: 'image/webp' }),
      ];

      await onFileUpload(
        files,
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );

      expect(setFilePreviews).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
  });
});

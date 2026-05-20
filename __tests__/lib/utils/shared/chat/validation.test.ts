import {
  shouldPreventSubmission,
  validateMessageSubmission,
} from '@/lib/utils/shared/chat/validation';

import { FilePreview } from '@/types/chat';

import { describe, expect, it } from 'vitest';

describe('chat validation', () => {
  describe('validateMessageSubmission', () => {
    it('should validate empty message with no files', () => {
      const result = validateMessageSubmission('', [], {});
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Please enter a message');
    });

    it('should validate whitespace-only message with no files', () => {
      const result = validateMessageSubmission('   \n\t  ', [], {});
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Please enter a message');
    });

    it('should allow valid text message', () => {
      const result = validateMessageSubmission('Hello world', [], {});
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow message with files attached', () => {
      const files: FilePreview[] = [
        {
          name: 'document.pdf',
          type: 'application/pdf',
          previewUrl: 'blob:...',
          status: 'completed',
        },
      ];
      const result = validateMessageSubmission('Check this file', files, {});
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should allow empty message if files are attached', () => {
      const files: FilePreview[] = [
        {
          name: 'audio.mp3',
          type: 'audio/mpeg',
          previewUrl: 'blob:...',
          status: 'completed',
        },
      ];
      // This is valid for audio/video transcription without additional instructions
      const result = validateMessageSubmission('', files, {});
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should prevent submission when files are uploading', () => {
      const files: FilePreview[] = [
        {
          name: 'uploading.pdf',
          type: 'application/pdf',
          previewUrl: 'blob:...',
          status: 'uploading',
        },
      ];
      const uploadProgress = { '1': 50 }; // 50% uploaded
      const result = validateMessageSubmission(
        'Message',
        files,
        uploadProgress,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Please wait for files to finish uploading');
    });

    it('should prevent submission when any file is uploading', () => {
      const files: FilePreview[] = [
        {
          name: 'completed.pdf',
          type: 'application/pdf',
          previewUrl: 'blob:...',
          status: 'completed',
        },
        {
          name: 'uploading.jpg',
          type: 'image/jpeg',
          previewUrl: 'blob:...',
          status: 'uploading',
        },
      ];
      const uploadProgress = { '1': 100, '2': 75 };
      const result = validateMessageSubmission(
        'Message',
        files,
        uploadProgress,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Please wait for files to finish uploading');
    });

    it('should allow submission when all files are uploaded', () => {
      const files: FilePreview[] = [
        {
          name: 'file1.pdf',
          type: 'application/pdf',
          previewUrl: 'blob:...',
          status: 'completed',
        },
        {
          name: 'file2.jpg',
          type: 'image/jpeg',
          previewUrl: 'blob:...',
          status: 'completed',
        },
      ];
      const uploadProgress = { '1': 100, '2': 100 };
      const result = validateMessageSubmission(
        'Message',
        files,
        uploadProgress,
      );
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should handle edge case of 99% upload progress', () => {
      const files: FilePreview[] = [
        {
          name: 'almost.pdf',
          type: 'application/pdf',
          previewUrl: 'blob:...',
          status: 'uploading',
        },
      ];
      const uploadProgress = { '1': 99 };
      const result = validateMessageSubmission(
        'Message',
        files,
        uploadProgress,
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Please wait for files to finish uploading');
    });

    it('should handle empty uploadProgress object', () => {
      const result = validateMessageSubmission('Hello', [], {});
      expect(result.valid).toBe(true);
    });

    it('should handle multiple files with various progress states', () => {
      const uploadProgress = {
        '1': 100,
        '2': 0,
        '3': 50,
        '4': 100,
      };
      const result = validateMessageSubmission('Test', [], uploadProgress);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Please wait for files to finish uploading');
    });

    it('should allow submission with long message text', () => {
      const longMessage = 'a'.repeat(5000);
      const result = validateMessageSubmission(longMessage, [], {});
      expect(result.valid).toBe(true);
    });

    it('should handle message with only newlines', () => {
      const result = validateMessageSubmission('\n\n\n', [], {});
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Please enter a message');
    });

    it('should handle message with unicode characters', () => {
      const result = validateMessageSubmission('Hello 世界 🌍', [], {});
      expect(result.valid).toBe(true);
    });
  });

  describe('shouldPreventSubmission', () => {
    const completedFile: FilePreview = {
      name: 'completed.pdf',
      type: 'application/pdf',
      previewUrl: 'blob:...',
      status: 'completed',
    };

    const uploadingFile: FilePreview = {
      name: 'uploading.pdf',
      type: 'application/pdf',
      previewUrl: 'blob:...',
      status: 'uploading',
    };

    it('should prevent submission when transcribing', () => {
      const result = shouldPreventSubmission(true, false, [], {});
      expect(result).toBe(true);
    });

    it('should prevent submission when streaming', () => {
      const result = shouldPreventSubmission(false, true, [], {});
      expect(result).toBe(true);
    });

    it('should prevent submission when files are uploading (status)', () => {
      const result = shouldPreventSubmission(false, false, [uploadingFile], {});
      expect(result).toBe(true);
    });

    it('should prevent submission when upload progress is incomplete', () => {
      const uploadProgress = { '1': 50 };
      const result = shouldPreventSubmission(false, false, [], uploadProgress);
      expect(result).toBe(true);
    });

    it('should allow submission when all conditions are met', () => {
      const uploadProgress = { '1': 100 };
      const result = shouldPreventSubmission(
        false,
        false,
        [completedFile],
        uploadProgress,
      );
      expect(result).toBe(false);
    });

    it('should allow submission with no files', () => {
      const result = shouldPreventSubmission(false, false, [], {});
      expect(result).toBe(false);
    });

    it('should prevent submission when multiple blocking conditions exist', () => {
      const uploadProgress = { '1': 50 };
      const result = shouldPreventSubmission(
        true,
        true,
        [uploadingFile],
        uploadProgress,
      );
      expect(result).toBe(true);
    });

    it('should detect uploading status from file preview', () => {
      const files: FilePreview[] = [completedFile, uploadingFile];
      const result = shouldPreventSubmission(false, false, files, {});
      expect(result).toBe(true);
    });

    it('should handle multiple completed files', () => {
      const files: FilePreview[] = [
        {
          name: 'file1.pdf',
          type: 'application/pdf',
          previewUrl: 'blob:...',
          status: 'completed',
        },
        {
          name: 'file2.pdf',
          type: 'application/pdf',
          previewUrl: 'blob:...',
          status: 'completed',
        },
      ];
      const uploadProgress = { '1': 100, '2': 100 };
      const result = shouldPreventSubmission(
        false,
        false,
        files,
        uploadProgress,
      );
      expect(result).toBe(false);
    });

    it('should prevent when at least one file is uploading', () => {
      const files: FilePreview[] = [
        completedFile,
        completedFile,
        uploadingFile,
        completedFile,
      ];
      const result = shouldPreventSubmission(false, false, files, {});
      expect(result).toBe(true);
    });

    it('should prevent when transcribing overrides everything else', () => {
      const uploadProgress = { '1': 100 };
      const result = shouldPreventSubmission(
        true,
        false,
        [completedFile],
        uploadProgress,
      );
      expect(result).toBe(true);
    });

    it('should prevent when streaming overrides everything else', () => {
      const uploadProgress = { '1': 100 };
      const result = shouldPreventSubmission(
        false,
        true,
        [completedFile],
        uploadProgress,
      );
      expect(result).toBe(true);
    });

    it('should check both file status and upload progress', () => {
      // File status says completed, but progress says incomplete
      const files: FilePreview[] = [completedFile];
      const uploadProgress = { '1': 75 };
      const result = shouldPreventSubmission(
        false,
        false,
        files,
        uploadProgress,
      );
      expect(result).toBe(true);
    });

    it('should handle empty progress object with completed files', () => {
      const result = shouldPreventSubmission(false, false, [completedFile], {});
      expect(result).toBe(false);
    });

    it('should handle file with error status', () => {
      const errorFile: FilePreview = {
        name: 'error.pdf',
        type: 'application/pdf',
        previewUrl: 'blob:...',
        status: 'failed',
      };
      const result = shouldPreventSubmission(false, false, [errorFile], {});
      // Error status should allow submission (not blocking like uploading)
      expect(result).toBe(false);
    });

    it('should detect any incomplete upload in progress map', () => {
      const uploadProgress = {
        '1': 100,
        '2': 100,
        '3': 99, // Almost done but not quite
        '4': 100,
      };
      const result = shouldPreventSubmission(false, false, [], uploadProgress);
      expect(result).toBe(true);
    });

    it('should allow when all uploads are at 100%', () => {
      const uploadProgress = {
        '1': 100,
        '2': 100,
        '3': 100,
      };
      const result = shouldPreventSubmission(false, false, [], uploadProgress);
      expect(result).toBe(false);
    });
  });

  describe('Integration scenarios', () => {
    it('should handle complete file upload workflow', () => {
      // Step 1: File starts uploading
      let files: FilePreview[] = [
        {
          name: 'document.pdf',
          type: 'application/pdf',
          previewUrl: 'blob:...',
          status: 'uploading',
        },
      ];
      let uploadProgress = { '1': 0 };

      expect(
        validateMessageSubmission('Process this', files, uploadProgress).valid,
      ).toBe(false);
      expect(shouldPreventSubmission(false, false, files, uploadProgress)).toBe(
        true,
      );

      // Step 2: File is 50% uploaded
      uploadProgress = { '1': 50 };
      expect(
        validateMessageSubmission('Process this', files, uploadProgress).valid,
      ).toBe(false);
      expect(shouldPreventSubmission(false, false, files, uploadProgress)).toBe(
        true,
      );

      // Step 3: File upload completes
      files = [
        {
          name: 'document.pdf',
          type: 'application/pdf',
          previewUrl: 'blob:...',
          status: 'completed',
        },
      ];
      uploadProgress = { '1': 100 };

      expect(
        validateMessageSubmission('Process this', files, uploadProgress).valid,
      ).toBe(true);
      expect(shouldPreventSubmission(false, false, files, uploadProgress)).toBe(
        false,
      );
    });

    it('should handle audio transcription workflow', () => {
      // User uploads audio file without message (just want transcription)
      const files: FilePreview[] = [
        {
          name: 'meeting.mp3',
          type: 'audio/mpeg',
          previewUrl: 'blob:...',
          status: 'completed',
        },
      ];

      // Empty message is allowed because file is attached
      expect(validateMessageSubmission('', files, { '1': 100 }).valid).toBe(
        true,
      );

      // But during transcription, submission should be prevented
      expect(shouldPreventSubmission(true, false, files, { '1': 100 })).toBe(
        true,
      );

      // After transcription, with AI response streaming, still prevented
      expect(shouldPreventSubmission(false, true, files, { '1': 100 })).toBe(
        true,
      );

      // After everything completes, allowed
      expect(shouldPreventSubmission(false, false, files, { '1': 100 })).toBe(
        false,
      );
    });
  });
});

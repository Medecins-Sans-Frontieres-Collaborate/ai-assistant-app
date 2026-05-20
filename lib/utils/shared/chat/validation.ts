import { FilePreview } from '@/types/chat';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates whether a message can be submitted
 * Checks for uploading files and empty messages
 *
 * @param textFieldValue - The text content of the message
 * @param filePreviews - Array of file previews currently attached
 * @param uploadProgress - Object tracking upload progress for each file
 * @returns Validation result with valid flag and optional error message
 */
export const validateMessageSubmission = (
  textFieldValue: string,
  filePreviews: FilePreview[],
  uploadProgress: { [key: string]: number },
): ValidationResult => {
  // Check if any files are still uploading
  const isUploading = Object.values(uploadProgress).some(
    (progress) => progress < 100,
  );

  if (isUploading) {
    return {
      valid: false,
      error: 'Please wait for files to finish uploading',
    };
  }

  // Allow empty text if files are attached (e.g., audio/video transcription without instructions)
  const hasFiles = filePreviews.length > 0;
  if (!textFieldValue.trim() && !hasFiles) {
    return {
      valid: false,
      error: 'Please enter a message',
    };
  }

  return { valid: true };
};

/**
 * Checks if submission should be prevented based on various states
 *
 * @param isTranscribing - Whether audio transcription is in progress
 * @param isStreaming - Whether a response is currently streaming
 * @param filePreviews - Array of file previews
 * @param uploadProgress - Upload progress tracking object
 * @returns True if submission should be prevented
 */
export const shouldPreventSubmission = (
  isTranscribing: boolean,
  isStreaming: boolean,
  filePreviews: FilePreview[],
  uploadProgress: { [key: string]: number },
): boolean => {
  // Check if any files are still uploading
  const hasUploadingFiles = filePreviews.some(
    (preview) => preview.status === 'uploading',
  );

  const hasIncompleteUploads = Object.values(uploadProgress).some(
    (progress) => progress < 100,
  );

  return (
    isTranscribing || isStreaming || hasUploadingFiles || hasIncompleteUploads
  );
};

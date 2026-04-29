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
  // Files in `pending` or `extracting` may have no `uploadProgress` entry yet,
  // so a progress-only check lets the user send before extraction completes
  // and the attachment is silently dropped from the turn.
  const hasInFlightFile = filePreviews.some(
    (p) =>
      p.status === 'pending' ||
      p.status === 'uploading' ||
      p.status === 'extracting',
  );
  const hasIncompleteProgress = Object.values(uploadProgress).some(
    (progress) => progress < 100,
  );

  if (hasInFlightFile || hasIncompleteProgress) {
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
  // Match every non-terminal upload status, not just `uploading`. `pending`
  // and `extracting` files have no progress entry yet and would otherwise
  // slip through.
  const hasInFlightFile = filePreviews.some(
    (preview) =>
      preview.status === 'pending' ||
      preview.status === 'uploading' ||
      preview.status === 'extracting',
  );

  const hasIncompleteUploads = Object.values(uploadProgress).some(
    (progress) => progress < 100,
  );

  return (
    isTranscribing || isStreaming || hasInFlightFile || hasIncompleteUploads
  );
};

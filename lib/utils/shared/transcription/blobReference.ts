/**
 * Pure helpers for parsing the blob-transcript reference marker used to
 * embed large transcripts by reference in message content.
 *
 * Format: `[Transcript: filename | blob:jobId | expires:ISO_TIMESTAMP]`
 *
 * Keeping the regex + helpers in one place avoids drift between the two
 * components that display blob transcripts.
 */

/** Matches a blob transcript reference at message content boundaries. */
export const BLOB_REFERENCE_REGEX =
  /^\[Transcript:\s*(.+?)\s*\|\s*blob:([a-fA-F0-9-]+)\s*\|\s*expires:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)\]$/;

export interface BlobReference {
  filename: string;
  jobId: string;
  expiresAt: Date;
}

/**
 * Parses a blob transcript reference string.
 * Returns null if the content is not a blob reference.
 */
export function parseBlobReference(content: string): BlobReference | null {
  const match = content.trim().match(BLOB_REFERENCE_REGEX);
  if (!match) return null;
  return {
    filename: match[1],
    jobId: match[2],
    expiresAt: new Date(match[3]),
  };
}

/**
 * Days remaining until a transcript blob expires. Ceil-rounded; values ≤0
 * indicate the transcript is already expired.
 */
export function getDaysUntilExpiry(expiresAt: Date): number {
  const diffMs = expiresAt.getTime() - Date.now();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

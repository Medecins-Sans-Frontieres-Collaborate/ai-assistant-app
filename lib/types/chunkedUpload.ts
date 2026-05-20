/**
 * Types for chunked file upload operations.
 *
 * Chunked uploads split large files into smaller pieces (chunks) and upload
 * them individually. This enables progress tracking for large files and uses
 * Azure Block Blob API for efficient server-side reassembly.
 */

/**
 * Session data for a chunked upload operation.
 * Created during initialization and used throughout the upload process.
 */
export interface ChunkedUploadSession {
  /** Unique identifier for this upload session */
  uploadId: string;
  /** Original filename */
  filename: string;
  /** File type category for determining storage location */
  filetype: 'image' | 'file' | 'audio' | 'video';
  /** MIME type of the file */
  mimeType: string;
  /** Total file size in bytes */
  totalSize: number;
  /** Total number of chunks to upload */
  totalChunks: number;
  /** Size of each chunk in bytes */
  chunkSize: number;
  /** Path where the blob will be stored */
  blobPath: string;
}

/**
 * Result of uploading a single chunk.
 */
export interface ChunkUploadResult {
  /** Whether the chunk was uploaded successfully */
  success: boolean;
  /** Index of the chunk that was uploaded */
  chunkIndex: number;
  /** Block ID assigned to this chunk (base64 encoded) */
  blockId?: string;
  /** Error message if upload failed */
  error?: string;
}

/**
 * Result of finalizing a chunked upload.
 */
export interface FinalizeUploadResult {
  /** Whether finalization was successful */
  success: boolean;
  /** Final URI of the uploaded blob */
  uri?: string;
  /** Error message if finalization failed */
  error?: string;
}

/**
 * Parameters for initializing a chunked upload.
 */
export interface InitChunkedUploadParams {
  /** Original filename */
  filename: string;
  /** File type category */
  filetype: 'image' | 'file' | 'audio' | 'video';
  /** MIME type of the file */
  mimeType: string;
  /** Total file size in bytes */
  totalSize: number;
  /** Size of each chunk in bytes */
  chunkSize: number;
}

/**
 * Parameters for uploading a single chunk.
 */
export interface UploadChunkParams {
  /** The upload session */
  session: ChunkedUploadSession;
  /** Index of this chunk (0-based) */
  chunkIndex: number;
  /** The chunk data as FormData with 'chunk' field */
  chunkData: FormData;
}

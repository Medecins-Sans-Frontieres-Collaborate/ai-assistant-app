import { FilePreview } from '@/types/chat';

/**
 * Revoke an object URL created via URL.createObjectURL. Safe to call on
 * non-blob URLs (no-op for http/https refs from completed uploads). Wrapped
 * in try/catch because revoke can throw on browsers that have already GC'd
 * the underlying Blob.
 */
export function revokeIfBlobUrl(url: string | undefined | null): void {
  if (!url || !url.startsWith('blob:')) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* already revoked or unsupported — nothing to do */
  }
}

/** Revoke every blob: preview URL in the array (no-op for non-blob URLs). */
export function revokeAllPreviewUrls(previews: FilePreview[]): void {
  for (const preview of previews) {
    revokeIfBlobUrl(preview.previewUrl);
  }
}

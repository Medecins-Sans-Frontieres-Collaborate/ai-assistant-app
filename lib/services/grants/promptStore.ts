/**
 * Persistence for per-OC extraction-prompt overrides.
 *
 * The default prompt is generated in code (`buildExtractionPrompt`). Stakeholders
 * can tune it per OC from the UI; the tuned version is stored as a single blob
 * per OC — SHARED across users (Nelli and Mary collaborate on the same task, hence why
 * we arent using localstorage), so whoever runs an extraction picks up
 * the latest saved prompt. Resetting removes the blob and falls back to the code default.
 */
import type { BlobStorage } from '@/lib/utils/server/blob/blob';
import { BlobProperty } from '@/lib/utils/server/blob/blob';

export interface PromptOverride {
  prompt: string;
  updatedBy: string;
  updatedAt: string;
}

/** Blob path holding the saved prompt override for an OC (shared across users). */
export function promptOverrideBlobPath(oc: string): string {
  return `grants/${oc.toLowerCase()}/prompt-override.json`;
}

/** Load the saved prompt override for an OC, or null if none has been saved. */
export async function loadPromptOverride(
  storage: BlobStorage,
  oc: string,
): Promise<PromptOverride | null> {
  const path = promptOverrideBlobPath(oc);
  try {
    if (!(await storage.blobExists(path))) return null;
    const buf = (await storage.get(path, BlobProperty.BLOB)) as Buffer;
    const parsed = JSON.parse(buf.toString('utf-8')) as PromptOverride;
    if (!parsed || typeof parsed.prompt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist a prompt override for an OC (shared across users). */
export async function savePromptOverride(
  storage: BlobStorage,
  oc: string,
  prompt: string,
  updatedBy: string,
): Promise<PromptOverride> {
  const record: PromptOverride = {
    prompt,
    updatedBy,
    updatedAt: new Date().toISOString(),
  };
  await storage.upload(
    promptOverrideBlobPath(oc),
    JSON.stringify(record, null, 2),
  );
  return record;
}

/** Remove the saved override for an OC (reset to the code default). */
export async function deletePromptOverride(
  storage: BlobStorage,
  oc: string,
): Promise<boolean> {
  return storage.deleteIfExists(promptOverrideBlobPath(oc));
}

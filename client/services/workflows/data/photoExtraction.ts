'use client';

import { FileUploadService } from '@/client/services/fileUploadService';
import { PhotoInferResult } from '@/lib/services/workflows/data/photoIngest';

import { downscaleImage } from '@/client/utils/downscaleImage';

import { DataColumn } from '@/types/workflow';

/**
 * Client pipeline for photo → data: downscale each photo (EXIF-aware,
 * ≤2048px JPEG), upload to the user's image bucket (which also pre-warms
 * the client base64 cache — the QC pane's first render is free), then
 * run the vision extraction with the internal refs only.
 */

export interface UploadedPhoto {
  /** Internal '/api/file/{sha}.{ext}' ref. */
  url: string;
  originalFilename: string;
}

export async function uploadPhotos(files: File[]): Promise<UploadedPhoto[]> {
  const uploaded: UploadedPhoto[] = [];
  for (const file of files) {
    const resized = await downscaleImage(file);
    const result = await FileUploadService.uploadImage(resized);
    uploaded.push({ url: result.url, originalFilename: file.name });
  }
  return uploaded;
}

export async function photoInfer(input: {
  imageRefs: string[];
  instructions?: string;
  modelId?: string;
}): Promise<PhotoInferResult> {
  return callPhotoRoute<PhotoInferResult>({ ...input, mode: 'infer' });
}

export async function photoExtract(input: {
  imageRefs: string[];
  columns: DataColumn[];
  instructions?: string;
  modelId?: string;
}): Promise<{ rows: Record<string, unknown>[] }> {
  return callPhotoRoute<{ rows: Record<string, unknown>[] }>({
    ...input,
    mode: 'extract',
  });
}

async function callPhotoRoute<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('/api/workflows/data/photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (!response.ok || !parsed?.success) {
    throw new Error(
      parsed?.error || `Photo extraction failed (${response.status})`,
    );
  }
  return parsed.data as T;
}

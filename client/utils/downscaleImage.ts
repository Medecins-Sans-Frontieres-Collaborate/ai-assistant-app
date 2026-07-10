'use client';

import { FILE_SIZE_LIMITS } from '@/lib/utils/app/const';

/**
 * Downscales a photo for LLM vision extraction: EXIF-aware decode,
 * ≤2048px long edge (vision models tile above that anyway), JPEG
 * re-encode under the 5MB upload cap. First image-processing util in the
 * app — no precedent existed.
 */

const MAX_LONG_EDGE = 2_048;
const JPEG_QUALITY = 0.85;
const JPEG_QUALITY_RETRY = 0.7;

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
}

async function decodeImage(file: File): Promise<DecodedImage> {
  // Preferred: createImageBitmap applying EXIF orientation explicitly.
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: 'from-image',
    });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  } catch {
    // Older engines reject the option ('from-image' is their default
    // behavior anyway) — retry without it.
  }
  try {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      cleanup: () => bitmap.close(),
    };
  } catch {
    // Final fallback: <img> decode (browsers EXIF-orient it by default).
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error instanceof Error ? error : new Error('Image decode failed');
  }
}

function toJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error('JPEG encoding failed')),
      'image/jpeg',
      quality,
    );
  });
}

/**
 * Returns a JPEG File ready for upload. Throws on undecodable input
 * (e.g. HEIC outside iOS) — callers surface a translated error.
 */
export async function downscaleImage(file: File): Promise<File> {
  const decoded = await decodeImage(file);
  try {
    const scale = Math.min(
      1,
      MAX_LONG_EDGE / Math.max(decoded.width, decoded.height),
    );
    const width = Math.max(1, Math.round(decoded.width * scale));
    const height = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    // JPEG has no alpha: transparent regions would render black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(decoded.source, 0, 0, width, height);

    let blob = await toJpegBlob(canvas, JPEG_QUALITY);
    if (blob.size > FILE_SIZE_LIMITS.IMAGE_MAX_BYTES) {
      blob = await toJpegBlob(canvas, JPEG_QUALITY_RETRY);
    }
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', {
      type: 'image/jpeg',
    });
  } finally {
    decoded.cleanup();
  }
}

'use client';

import { IconPhoto } from '@tabler/icons-react';
import { useEffect, useState } from 'react';

import { fetchImageBase64FromMessageContent } from '@/lib/services/imageService';

interface MediaThumbProps {
  /** Internal '/api/file/{sha}.{ext}' ref. */
  imageRef: string;
  /** The image's alt text; empty renders the image as not yet described. */
  alt: string;
  className?: string;
}

/**
 * An attached image, loaded from the user's own file store the same way the
 * data workflow shows its photos. Keyed by ref, so a result for a previous
 * image is simply not this image's result.
 */
export function MediaThumb({ imageRef, alt, className }: MediaThumbProps) {
  const [loaded, setLoaded] = useState<{ ref: string; data: string } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void fetchImageBase64FromMessageContent({
      type: 'image_url',
      image_url: { url: imageRef, detail: 'auto' },
    }).then((data) => {
      if (!cancelled && data) setLoaded({ ref: imageRef, data });
    });
    return () => {
      cancelled = true;
    };
  }, [imageRef]);

  const data = loaded?.ref === imageRef ? loaded.data : null;
  if (!data) {
    return (
      <span
        className={`flex items-center justify-center rounded-lg bg-gray-200 dark:bg-surface-dark-elevated ${className ?? ''}`}
      >
        <IconPhoto size={18} aria-hidden className="text-gray-500" />
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={data}
      alt={alt}
      className={`rounded-lg object-cover ${className ?? ''}`}
    />
  );
}

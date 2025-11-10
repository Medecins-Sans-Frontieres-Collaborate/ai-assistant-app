import { IconX } from '@tabler/icons-react';
import React, { FC, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { fetchImageBase64FromMessageContent } from '@/lib/services/imageService';

import { ImageMessageContent } from '@/types/chat';

/**
 * Lightbox modal for full-screen image viewing
 */
interface LightboxProps {
  imageUrl: string;
  onClose: () => void;
}

const Lightbox: FC<LightboxProps> = ({ imageUrl, onClose }) => {
  const t = useTranslations();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 text-white hover:text-gray-300 transition-colors"
        onClick={onClose}
        aria-label={t('common.close')}
      >
        <IconX size={32} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt={t('chat.fullSizePreview')}
        className="max-w-[90vw] max-h-[90vh] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
};

/**
 * Props for ImageContent component
 */
interface ImageContentProps {
  images: ImageMessageContent[];
}

/**
 * ImageContent Component
 *
 * Renders images from message content with loading states, error handling,
 * and lightbox functionality. Supports single and multiple image layouts.
 */
export const ImageContent: FC<ImageContentProps> = ({ images }) => {
  const [imageBase64s, setImageBase64s] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<boolean>(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Use JSON.stringify for stable comparison of array contents
  const imagesKey = JSON.stringify(images);

  useEffect(() => {
    if (images.length > 0) {
      setIsLoading(true);
      setLoadError(false);

      Promise.all(images.map((img) => fetchImageBase64FromMessageContent(img)))
        .then((base64Strings) => {
          if (base64Strings.every((str) => str.length > 0)) {
            setImageBase64s(base64Strings);
          } else {
            setLoadError(true);
          }
        })
        .catch(() => {
          setLoadError(true);
        })
        .finally(() => {
          setIsLoading(false);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagesKey]);

  const openLightbox = (imageUrl: string) => {
    setLightboxImage(imageUrl);
  };

  // Render lightbox if an image is selected
  if (lightboxImage) {
    return (
      <Lightbox
        imageUrl={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />
    );
  }

  return (
    <div className="not-prose">
      {/* Loading state */}
      {isLoading && (
        <div className="flex flex-wrap gap-2 mb-2">
          {Array.from({ length: images.length || 1 }).map((_, i) => (
            <div
              key={i}
              className={`bg-gray-200 dark:bg-gray-700 animate-pulse rounded-lg border border-gray-200 dark:border-gray-700 ${
                images.length === 1
                  ? 'w-full max-w-md'
                  : 'w-[calc(50%-0.25rem)]'
              }`}
              style={{
                height: images.length === 1 ? '300px' : '200px',
              }}
            >
              <div className="w-full h-full flex items-center justify-center">
                <span className="text-gray-500 dark:text-gray-400 text-sm">
                  Loading...
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error state */}
      {loadError && (
        <div className="border border-red-300 dark:border-red-700 rounded-lg p-4 text-red-500 inline-block mb-2">
          <span>Failed to load image(s)</span>
        </div>
      )}

      {/* Loaded images */}
      {!isLoading && !loadError && imageBase64s.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {imageBase64s.map((imageBase64, index) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={index}
              onClick={() => openLightbox(imageBase64)}
              className={`rounded-lg hover:cursor-pointer hover:opacity-90 transition-opacity border border-gray-200 dark:border-gray-700 ${
                imageBase64s.length === 1
                  ? 'w-full max-w-md'
                  : 'w-[calc(50%-0.25rem)]'
              }`}
              style={{
                objectFit: 'cover',
                maxHeight: imageBase64s.length === 1 ? '400px' : '200px',
                height: imageBase64s.length > 1 ? '200px' : 'auto',
              }}
              src={imageBase64}
              alt={`Image ${index + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ImageContent;

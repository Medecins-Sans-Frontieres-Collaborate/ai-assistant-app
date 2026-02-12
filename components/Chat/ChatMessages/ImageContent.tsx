import { IconDownload, IconX } from '@tabler/icons-react';
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
  const t = useTranslations('chat');
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

  /**
   * Downloads an image by creating a temporary link element
   */
  const downloadImage = (
    event: React.MouseEvent,
    base64Data: string,
    index: number,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    // Create a temporary link and trigger download
    const link = document.createElement('a');
    link.href = base64Data;
    link.download = `image-${index + 1}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
    <div className="flex flex-wrap gap-2 w-full py-2">
      {/* Loading state */}
      {isLoading &&
        Array.from({ length: images.length || 1 }).map((_, i) => (
          <div
            key={i}
            className="relative rounded-lg overflow-hidden border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
            style={{
              width: 'calc(50% - 0.25rem)',
              maxWidth: '280px',
              minWidth: '200px',
              height: '150px',
            }}
          >
            <div className="w-full h-full bg-gray-200 dark:bg-gray-700 animate-shimmer">
              <span className="sr-only">{t('loadingImage')}</span>
            </div>
          </div>
        ))}

      {/* Error state */}
      {loadError && (
        <div
          className="relative rounded-lg overflow-hidden border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900"
          style={{
            width: 'calc(50% - 0.25rem)',
            maxWidth: '280px',
            minWidth: '200px',
            height: '150px',
          }}
        >
          <div className="flex items-center justify-center w-full h-full text-red-500 text-sm p-3">
            <span>{t('failedToLoadImage')}</span>
          </div>
        </div>
      )}

      {/* Loaded images */}
      {!isLoading &&
        !loadError &&
        imageBase64s.length > 0 &&
        imageBase64s.map((imageBase64, index) => (
          <div
            key={index}
            className="relative rounded-lg overflow-hidden border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 hover:shadow-lg transition-shadow cursor-pointer group"
            style={{
              width: 'calc(50% - 0.25rem)',
              maxWidth: '280px',
              minWidth: '200px',
              height: '150px',
            }}
            onClick={() => openLightbox(imageBase64)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageBase64}
              alt={t('imageAlt', { number: index + 1 })}
              className="w-full h-full object-cover"
            />
            {/* Hover overlay with badge and download icon */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-bold bg-purple-500 text-white">
                IMG
              </div>
              <button
                onClick={(e) => downloadImage(e, imageBase64, index)}
                className="absolute top-2 right-2 p-1.5 rounded-full bg-white/90 dark:bg-gray-800/90 hover:bg-white dark:hover:bg-gray-700 transition-colors"
                title={t('download')}
              >
                <IconDownload className="w-4 h-4 text-gray-700 dark:text-gray-300" />
              </button>
            </div>
          </div>
        ))}
    </div>
  );
};

export default ImageContent;

import React, {
  ChangeEvent,
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import toast from 'react-hot-toast';

import { useFormatter, useTranslations } from 'next-intl';

import { useMyLimits } from '@/client/hooks/settings/useMyLimits';

import { FileUploadService } from '@/client/services/fileUploadService';

import { FILE_SIZE_LIMITS_MB } from '@/lib/utils/app/const';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
} from '@/types/chat';

import FileIcon from '@/components/Icons/file';

import { ATTACH_ACCEPT_TYPES } from '@/lib/constants/fileTypes';

/** Admin per-file ceiling (docs/LIMITS.md); `null` value = unlimited. */
const UPLOAD_MB_LIMIT_KEY = 'feature.upload.megabytesPerFile';

/**
 * The caller's resolved `feature.upload.megabytesPerFile`, or `undefined`
 * when no numeric cap applies. Ceiling rows carry `value` but never
 * `remaining`, so this reads `limits[]` directly rather than going through
 * `useLimitGates().featureRemaining` (counters only). Only the unqualified
 * row counts — the key is never model-qualified. Fail open: flag off,
 * observe mode or an unreadable policy all read as "no cap".
 */
export function useEffectiveUploadMegabytes(): number | undefined {
  const { enforce, limits } = useMyLimits();
  return useMemo(() => {
    if (!enforce) return undefined;
    const row = limits.find(
      (candidate) =>
        candidate.limitKey === UPLOAD_MB_LIMIT_KEY &&
        !candidate.modelId &&
        !candidate.series &&
        typeof candidate.value === 'number',
    );
    return typeof row?.value === 'number' ? row.value : undefined;
  }, [enforce, limits]);
}

/**
 * Keeps `FileUploadService`'s module-level admin cap in step with the
 * caller's limits so every upload entry point (drop, paste, camera, "+"
 * menu, extraction tray) rejects an oversized file BEFORE the upload starts,
 * through the same `validateFile` → toast path the compiled category caps
 * use. Mount ONCE near the composer; clears the cap on unmount so a
 * signed-out or re-rendered shell never keeps a stale number.
 *
 * Returns the cap so the caller can show it ("Files up to 20MB").
 */
export function useUploadLimitSync(): number | undefined {
  const t = useTranslations('limitsUx.routes');
  const megabytes = useEffectiveUploadMegabytes();

  useEffect(() => {
    if (megabytes === undefined) {
      FileUploadService.setEffectiveUploadLimit(null);
      return;
    }
    FileUploadService.setEffectiveUploadLimit({
      megabytes,
      formatError: (fileName, maxSize) =>
        t('uploadTooLarge', { fileName, maxSize }),
    });
    return () => FileUploadService.setEffectiveUploadLimit(null);
  }, [megabytes, t]);

  return megabytes;
}

interface ChatInputFileProps {
  onFileUpload: (
    event: React.ChangeEvent<any>,
    setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>,
    setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>,
    setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>,
    setImageFieldValue: Dispatch<SetStateAction<FileFieldValue>>,
    setUploadProgress: Dispatch<SetStateAction<{ [key: string]: number }>>,
  ) => void;
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>;
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setImageFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setUploadProgress: Dispatch<SetStateAction<{ [key: string]: number }>>;
}

const ChatInputFile = ({
  onFileUpload,
  setSubmitType,
  setFilePreviews,
  setFileFieldValue,
  setImageFieldValue,
  setUploadProgress,
}: ChatInputFileProps) => {
  const t = useTranslations('chatInput');
  const tRoutes = useTranslations('limitsUx.routes');
  const format = useFormatter();
  const fileInputRef: MutableRefObject<any> = useRef(null);
  const uploadMegabytes = useUploadLimitSync();

  const handleFileButtonClick = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    event.preventDefault();
    try {
      if (fileInputRef.current) {
        fileInputRef.current.click();
      } else {
        console.error('File input reference is not available');
        toast.error(t('filePickerError'));
      }
    } catch (error) {
      console.error('Error triggering file input:', error);
      toast.error(t('filePickerError'));
    }
  };

  return (
    <>
      <input
        type="file"
        multiple
        accept={ATTACH_ACCEPT_TYPES}
        ref={fileInputRef}
        className="opacity-0 absolute w-px h-px overflow-hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          event.preventDefault();
          onFileUpload(
            event,
            setSubmitType,
            setFilePreviews,
            setFileFieldValue,
            setImageFieldValue,
            setUploadProgress,
          );
        }}
      />
      <div className="relative group">
        <button onClick={handleFileButtonClick} className="flex">
          <FileIcon className="text-black dark:text-white rounded h-5 w-5 hover:bg-gray-200 dark:hover:bg-gray-700" />
          <span className="sr-only">{t('addDocument')}</span>
        </button>
        <div className="absolute left-1/2 transform -translate-x-1/2 bottom-full mb-2 hidden group-hover:block bg-black text-white text-xs py-1 px-2 rounded shadow-md whitespace-nowrap">
          {t('uploadDocument')}
          {/* Surface the admin cap up front — the user picks a smaller file
              instead of discovering the cap from the rejection toast. Only
              when the cap undercuts the smallest compiled category cap
              (images, FILE_SIZE_LIMITS_MB.IMAGE): validateFile still
              enforces the compiled per-category cap as the floor, so a
              hint above that would promise a size some category can never
              reach (e.g. "Files up to 100MB" while a 6MB image still 403s
              at the compiled 5MB image cap). */}
          {uploadMegabytes !== undefined &&
            uploadMegabytes < FILE_SIZE_LIMITS_MB.IMAGE && (
              <span className="block text-gray-300">
                {tRoutes('uploadCapHint', {
                  maxSize: `${format.number(uploadMegabytes)}MB`,
                })}
              </span>
            )}
        </div>
      </div>
    </>
  );
};

export default ChatInputFile;

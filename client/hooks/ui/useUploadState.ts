import { useCallback, useState } from 'react';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
  ImageFieldValue,
} from '@/types/chat';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';

export interface UseUploadStateReturn {
  filePreviews: FilePreview[];
  setFilePreviews: React.Dispatch<React.SetStateAction<FilePreview[]>>;
  fileFieldValue: FileFieldValue;
  setFileFieldValue: React.Dispatch<React.SetStateAction<FileFieldValue>>;
  imageFieldValue: ImageFieldValue;
  setImageFieldValue: React.Dispatch<React.SetStateAction<ImageFieldValue>>;
  uploadProgress: { [key: string]: number };
  setUploadProgress: React.Dispatch<
    React.SetStateAction<{ [key: string]: number }>
  >;
  submitType: ChatInputSubmitTypes;
  setSubmitType: React.Dispatch<React.SetStateAction<ChatInputSubmitTypes>>;
  handleFileUpload: (
    event: React.ChangeEvent<HTMLInputElement> | FileList | File[],
  ) => Promise<void>;
  clearUploadState: () => void;
}

export function useUploadState(): UseUploadStateReturn {
  const [filePreviews, setFilePreviews] = useState<FilePreview[]>([]);
  const [fileFieldValue, setFileFieldValue] = useState<FileFieldValue>(null);
  const [imageFieldValue, setImageFieldValue] = useState<ImageFieldValue>(null);
  const [uploadProgress, setUploadProgress] = useState<{
    [key: string]: number;
  }>({});
  const [submitType, setSubmitType] = useState<ChatInputSubmitTypes>('TEXT');

  const handleFileUpload = useCallback(
    async (event: React.ChangeEvent<any> | FileList | File[]) => {
      await onFileUpload(
        event,
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );
    },
    [],
  );

  const clearUploadState = useCallback(() => {
    setFilePreviews([]);
    setFileFieldValue(null);
    setImageFieldValue(null);
    setUploadProgress({});
    setSubmitType('TEXT');
  }, []);

  return {
    filePreviews,
    setFilePreviews,
    fileFieldValue,
    setFileFieldValue,
    imageFieldValue,
    setImageFieldValue,
    uploadProgress,
    setUploadProgress,
    submitType,
    setSubmitType,
    handleFileUpload,
    clearUploadState,
  };
}

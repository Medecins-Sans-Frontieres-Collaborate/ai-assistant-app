import React, { Dispatch, FC, SetStateAction } from 'react';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
  ImageFieldValue,
} from '@/types/chat';

import CameraCaptureModal from '@/components/UI/CameraCaptureModal';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';

interface CameraModalProps {
  isOpen: boolean;
  closeModal: () => void;
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>;
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setImageFieldValue: Dispatch<SetStateAction<ImageFieldValue>>;
  setUploadProgress: Dispatch<SetStateAction<{ [p: string]: number }>>;
}

/**
 * Chat-side wrapper around the shared capture modal: routes the captured
 * frame into the chat attachment pipeline.
 */
export const CameraModal: FC<CameraModalProps> = ({
  isOpen,
  closeModal,
  setFilePreviews,
  setSubmitType,
  setFileFieldValue,
  setImageFieldValue,
  setUploadProgress,
}) => (
  <CameraCaptureModal
    isOpen={isOpen}
    onClose={closeModal}
    onCapture={(file) => {
      onFileUpload(
        [file],
        setSubmitType,
        setFilePreviews,
        setFileFieldValue,
        setImageFieldValue,
        setUploadProgress,
      );
    }}
  />
);

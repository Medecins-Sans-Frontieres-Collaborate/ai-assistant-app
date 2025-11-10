import React, { Dispatch, MutableRefObject, SetStateAction } from 'react';
import toast from 'react-hot-toast';

import { FileUploadService } from '@/client/services/fileUploadService';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FileMessageContent,
  FilePreview,
  ImageMessageContent,
} from '@/types/chat';

import { isChangeEvent } from '@/client/handlers/chatInput/common';

export const onImageUpload = async (
  event: React.ChangeEvent<any> | Event | File,
  prompt: any,
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>,
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>,
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>,
  setUploadProgress?: Dispatch<SetStateAction<{ [key: string]: number }>>,
) => {
  let file: File;
  if (isChangeEvent(event)) {
    (event as React.ChangeEvent<any>).preventDefault();
    file = (event as React.ChangeEvent<any>).target.files[0];
  } else {
    file = event as File;
  }

  if (!file) {
    setSubmitType('TEXT');
    return;
  }

  try {
    const result = await FileUploadService.uploadSingleFile(
      file,
      (progress) => {
        if (setUploadProgress) {
          setUploadProgress((prev) => ({
            ...prev,
            [file.name]: progress,
          }));
        }
      },
    );

    const imageMessage: ImageMessageContent = {
      type: 'image_url',
      image_url: {
        url: result.url,
        detail: 'auto',
      },
    };

    setFileFieldValue((prevValue) => {
      if (prevValue && Array.isArray(prevValue)) {
        setSubmitType('MULTI_FILE');
        return [...prevValue, imageMessage] as (
          | FileMessageContent
          | ImageMessageContent
        )[];
      } else if (prevValue) {
        setSubmitType('MULTI_FILE');
        return [prevValue, imageMessage] as (
          | FileMessageContent
          | ImageMessageContent
        )[];
      } else {
        setSubmitType('IMAGE');
        return [imageMessage];
      }
    });

    // Update status to completed
    setFilePreviews((prevFilePreviews) =>
      prevFilePreviews.map((preview) =>
        preview.name === file.name
          ? { ...preview, status: 'completed' }
          : preview,
      ),
    );
  } catch (error) {
    console.error('Image upload failed:', error);
    toast.error(
      error instanceof Error
        ? error.message
        : `Failed to upload image: ${file.name}`,
    );

    // Update status to failed
    setFilePreviews((prevFilePreviews) =>
      prevFilePreviews.map((preview) =>
        preview.name === file.name ? { ...preview, status: 'failed' } : preview,
      ),
    );
  }
};

export function onImageUploadButtonClick(
  event: React.ChangeEvent<any>,
  fileInputRef: MutableRefObject<any>,
) {
  event.preventDefault();
  fileInputRef.current.click();
}

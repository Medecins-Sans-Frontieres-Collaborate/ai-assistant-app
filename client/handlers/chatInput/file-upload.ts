import React, { ChangeEvent, Dispatch, SetStateAction } from 'react';
import toast from 'react-hot-toast';

import { FileUploadService } from '@/client/services/fileUploadService';

import { FILE_COUNT_LIMITS } from '@/lib/utils/app/const';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FileMessageContent,
  FilePreview,
  ImageFieldValue,
  ImageMessageContent,
} from '@/types/chat';

import { isChangeEvent } from '@/client/handlers/chatInput/common';
import { isAudioVideoFileByTypeOrName } from '@/lib/constants/fileTypes';

export async function onFileUpload(
  event: React.ChangeEvent<HTMLInputElement> | FileList | File[],
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>,
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>,
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>,
  setImageFieldValue: Dispatch<SetStateAction<ImageFieldValue>>,
  setUploadProgress: Dispatch<SetStateAction<{ [key: string]: number }>>,
) {
  let files: FileList | File[];
  if (isChangeEvent(event)) {
    (event as React.ChangeEvent<any>).preventDefault();
    files = (event as React.ChangeEvent<any>).target.files;
  } else {
    files = event as FileList | File[];
  }

  if (files.length === 0) {
    toast.error('No files selected.');
    return;
  }

  const filesArray = Array.from(files);

  // Categorize files by type
  const images = filesArray.filter((file) => file.type.startsWith('image/'));
  const audioVideo = filesArray.filter((file) =>
    isAudioVideoFileByTypeOrName(file.name, file.type),
  );
  const documents = filesArray.filter(
    (file) =>
      !file.type.startsWith('image/') &&
      !isAudioVideoFileByTypeOrName(file.name, file.type),
  );

  // Validate count limits
  if (filesArray.length > FILE_COUNT_LIMITS.MAX_TOTAL_FILES) {
    toast.error(
      `Maximum ${FILE_COUNT_LIMITS.MAX_TOTAL_FILES} files allowed (you selected ${filesArray.length})`,
    );
    return;
  }

  if (images.length > FILE_COUNT_LIMITS.MAX_IMAGES) {
    toast.error(
      `Maximum ${FILE_COUNT_LIMITS.MAX_IMAGES} images allowed (you selected ${images.length})`,
    );
    return;
  }

  if (documents.length > FILE_COUNT_LIMITS.MAX_DOCUMENTS) {
    toast.error(
      `Maximum ${FILE_COUNT_LIMITS.MAX_DOCUMENTS} documents allowed (you selected ${documents.length})`,
    );
    return;
  }

  if (audioVideo.length > FILE_COUNT_LIMITS.MAX_AUDIO_VIDEO) {
    toast.error(
      `Maximum ${FILE_COUNT_LIMITS.MAX_AUDIO_VIDEO} audio/video file allowed (you selected ${audioVideo.length})`,
    );
    return;
  }

  // Validate total size
  const totalSize = filesArray.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > FILE_COUNT_LIMITS.MAX_TOTAL_SIZE) {
    const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(1);
    const maxSizeMB = (
      FILE_COUNT_LIMITS.MAX_TOTAL_SIZE /
      (1024 * 1024)
    ).toFixed(0);
    toast.error(`Total size ${totalSizeMB}MB exceeds ${maxSizeMB}MB limit`);
    return;
  }

  // Show warning for slow processing
  if (audioVideo.length > 0 && documents.length > 1) {
    toast('Processing audio + multiple documents may take 1-2 minutes', {
      icon: '⏱️',
      duration: 5000,
    });
  }

  // Initialize all file previews at once before processing
  const allFilePreviews: FilePreview[] = filesArray.map((file) => ({
    name: file.name,
    type: file.type,
    status: 'uploading',
    previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
    file: file, // Store the File object for local operations
  }));

  setFilePreviews((prevState) => [...prevState, ...allFilePreviews]);

  // Upload files using FileUploadService
  const results = await FileUploadService.uploadMultipleFiles(
    filesArray,
    (progressMap) => {
      setUploadProgress(progressMap);
    },
  );

  // Process successful uploads and update state
  results.forEach((result) => {
    if (result.type === 'image') {
      const imageMessage: ImageMessageContent = {
        type: 'image_url',
        image_url: {
          url: result.url,
          detail: 'auto',
        },
      };

      // Images go to imageFieldValue
      setImageFieldValue((prevValue) => {
        if (prevValue && Array.isArray(prevValue)) {
          return [...prevValue, imageMessage];
        } else if (prevValue) {
          return [prevValue, imageMessage];
        } else {
          return imageMessage;
        }
      });

      // Update submit type based on whether we have files too
      setSubmitType((prevType) => {
        // If we already have files, use multi-file
        if (prevType === 'FILE' || prevType === 'MULTI_FILE') {
          return 'MULTI_FILE';
        }
        return 'IMAGE';
      });
    } else {
      const fileMessage: FileMessageContent = {
        type: 'file_url',
        url: result.url,
        originalFilename: result.originalFilename,
      };

      setFileFieldValue((prevValue) => {
        let newFileArray: (FileMessageContent | ImageMessageContent)[];
        if (prevValue && Array.isArray(prevValue)) {
          newFileArray = [...prevValue, fileMessage];
        } else if (prevValue) {
          newFileArray = [prevValue, fileMessage];
        } else {
          newFileArray = [fileMessage];
        }

        // Update submit type based on whether we have images too
        setSubmitType((prevType) => {
          // If we already have images, use multi-file
          if (prevType === 'IMAGE') {
            return 'MULTI_FILE';
          }
          return newFileArray.length > 1 ? 'MULTI_FILE' : 'FILE';
        });

        return newFileArray;
      });
    }

    // Update preview status to completed
    setFilePreviews((prevPreviews) =>
      prevPreviews.map((preview) =>
        preview.name === result.originalFilename
          ? { ...preview, status: 'completed' }
          : preview,
      ),
    );
  });

  // Reset the file input value to allow re-upload of the same files if needed
  if (isChangeEvent(event)) {
    (event as React.ChangeEvent<any>).target.value = '';
  }
}

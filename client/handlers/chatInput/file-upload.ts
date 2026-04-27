import React, { ChangeEvent, Dispatch, SetStateAction } from 'react';
import toast from 'react-hot-toast';

import { FileUploadService } from '@/client/services/fileUploadService';

import { FILE_COUNT_LIMITS, FILE_SIZE_LIMITS } from '@/lib/utils/app/const';
import {
  AudioExtractionUnavailableError,
  extractAudioFromVideo,
  isAudioExtractionSupported,
} from '@/lib/utils/client/audio/audioExtractor';
import { isVideoFile } from '@/lib/utils/client/file/fileValidation';

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
  signal?: AbortSignal,
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

  // Process video files: extract audio before upload
  const filesToUpload: File[] = [];
  const extractionInfo: Map<
    string,
    { originalName: string; originalSize: number }
  > = new Map();

  for (const file of filesArray) {
    // Check if this is a video file that needs audio extraction
    if (
      isAudioVideoFileByTypeOrName(file.name, file.type) &&
      (await isVideoFile(file))
    ) {
      // Check if extraction is supported in this browser AND that the file
      // is small enough to safely buffer in memory. Files that fail this
      // check fall through to direct video upload — the server-side
      // transcription pipeline (real ffmpeg binary) handles them.
      if (!isAudioExtractionSupported(file)) {
        toast(
          `Uploading ${file.name} as-is (client-side extraction unavailable)`,
          { duration: 4000 },
        );
        filesToUpload.push(file);
        continue;
      }

      // Check video file size
      if (file.size > FILE_SIZE_LIMITS.VIDEO_MAX_BYTES) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        toast.error(
          `Video ${file.name} (${sizeMB}MB) exceeds 1GB limit for extraction`,
        );
        setFilePreviews((prev) =>
          prev.map((p) =>
            p.name === file.name ? { ...p, status: 'failed' } : p,
          ),
        );
        continue;
      }

      try {
        // Update preview to show extraction in progress
        setFilePreviews((prev) =>
          prev.map((p) =>
            p.name === file.name ? { ...p, status: 'extracting' } : p,
          ),
        );

        // Extract audio from video
        const result = await extractAudioFromVideo(file, {
          outputFormat: 'mp3',
          quality: 'medium',
          onProgress: (progress) => {
            // Update progress (extraction is 0-50%, upload is 50-100%)
            setUploadProgress((prev) => ({
              ...prev,
              [file.name]: progress.percent * 0.5,
            }));

            // Show progress toast for loading stage
            if (progress.stage === 'loading' && progress.percent === 0) {
              toast.loading('Loading audio extraction engine...', {
                id: `extract-${file.name}`,
              });
            } else if (progress.stage === 'complete') {
              toast.dismiss(`extract-${file.name}`);
            }
          },
        });

        // Store extraction info for the preview update
        extractionInfo.set(result.outputFilename, {
          originalName: file.name,
          originalSize: file.size,
        });

        // Show compression result
        const compressionPercent = (
          (1 - result.extractedSize / result.originalSize) *
          100
        ).toFixed(0);
        toast.success(
          `Extracted audio from ${file.name}: ${compressionPercent}% smaller`,
          { duration: 3000 },
        );

        // Update preview to show extraction complete, rename to audio file
        setFilePreviews((prev) =>
          prev.map((p) =>
            p.name === file.name
              ? {
                  ...p,
                  name: result.outputFilename,
                  type: 'audio/mpeg',
                  status: 'uploading',
                  extractedFromVideo: {
                    originalName: file.name,
                    originalSize: file.size,
                    extractedSize: result.extractedSize,
                  },
                }
              : p,
          ),
        );

        // Add extracted audio file to upload queue
        filesToUpload.push(result.audioFile);
      } catch (error) {
        // For recoverable extraction failures (CDN blocked, file too large,
        // browser missing capabilities), fall back to uploading the raw
        // video — the server-side transcription pipeline handles it.
        if (error instanceof AudioExtractionUnavailableError) {
          console.warn(
            `Client-side extraction unavailable for ${file.name} (${error.reason}); uploading raw video`,
          );
          toast.dismiss(`extract-${file.name}`);
          toast(`Uploading ${file.name} as-is`, { duration: 4000 });
          setFilePreviews((prev) =>
            prev.map((p) =>
              p.name === file.name ? { ...p, status: 'uploading' } : p,
            ),
          );
          filesToUpload.push(file);
          continue;
        }
        console.error('Audio extraction failed:', error);
        toast.error(
          error instanceof Error
            ? error.message
            : `Failed to extract audio from ${file.name}`,
        );
        setFilePreviews((prev) =>
          prev.map((p) =>
            p.name === file.name ? { ...p, status: 'failed' } : p,
          ),
        );
      }
    } else {
      // Not a video file, add directly to upload queue
      filesToUpload.push(file);
    }
  }

  // Upload files using FileUploadService
  const results = await FileUploadService.uploadMultipleFiles(
    filesToUpload,
    (progressMap) => {
      // Adjust progress for files that had extraction (extraction was 0-50%)
      const adjustedProgress: { [key: string]: number } = {};
      for (const [filename, progress] of Object.entries(progressMap)) {
        if (extractionInfo.has(filename)) {
          // This file was extracted, upload progress is 50-100%
          adjustedProgress[filename] = 50 + progress * 0.5;
        } else {
          adjustedProgress[filename] = progress;
        }
      }
      setUploadProgress(adjustedProgress);
    },
    signal,
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

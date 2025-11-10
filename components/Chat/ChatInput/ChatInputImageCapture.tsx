import { IconCamera } from '@tabler/icons-react';
import React, {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import { isMobile } from '@/lib/utils/app/env';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
  ImageFieldValue,
} from '@/types/chat';

import { CameraModal } from '@/components/Chat/ChatInput/CameraModal';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';

const onImageUploadButtonClick = async (
  event: React.MouseEvent<HTMLButtonElement> | MouseEvent,
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  canvasRef: MutableRefObject<HTMLCanvasElement | null>,
  fileInputRef: MutableRefObject<HTMLInputElement | null>,
  setIsCameraOpen: Dispatch<SetStateAction<boolean>>,
): Promise<void> => {
  event.preventDefault();

  if (navigator?.mediaDevices?.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setIsCameraOpen(true);
      }
    } catch (error) {
      console.error('Error accessing camera:', error);
    }
  }
};

export interface ChatInputImageCaptureProps {
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>;
  prompt: string;
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setImageFieldValue: Dispatch<SetStateAction<ImageFieldValue>>;
  setUploadProgress: Dispatch<SetStateAction<{ [p: string]: number }>>;
  visible?: boolean;
  hasCameraSupport: boolean;
}

export interface ChatInputImageCaptureRef {
  triggerCamera: () => void;
}

const ChatInputImageCapture = forwardRef<
  ChatInputImageCaptureRef,
  ChatInputImageCaptureProps
>(
  (
    {
      setSubmitType,
      prompt,
      setFilePreviews,
      setFileFieldValue,
      setImageFieldValue,
      setUploadProgress,
      visible = true,
      hasCameraSupport,
    },
    ref,
  ) => {
    const t = useTranslations();
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [isCameraOpen, setIsCameraOpen] = useState(false);
    const [isModalOpen, setIsModalOpen] = useState(false);

    const openModal = () => setIsModalOpen(true);
    const closeModal = () => setIsModalOpen(false);

    const handleCameraButtonClick = (
      e: React.MouseEvent<HTMLButtonElement> | null,
    ) => {
      if (isMobile()) {
        if (fileInputRef.current) {
          fileInputRef.current.click();
        }
      } else {
        onImageUploadButtonClick(
          e || (new MouseEvent('click') as any),
          videoRef,
          canvasRef,
          fileInputRef,
          setIsCameraOpen,
        ).then(() => {
          // Only open the modal after the camera is initialized
          openModal();
        });
      }
    };

    // Expose the trigger method through the ref
    useImperativeHandle(ref, () => ({
      triggerCamera: () => {
        if (hasCameraSupport) {
          handleCameraButtonClick(null);
        }
      },
    }));

    return (
      <>
        <canvas ref={canvasRef} style={{ display: 'none' }} />
        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          capture={'environment'}
          onChange={(event) => {
            onFileUpload(
              event,
              setSubmitType,
              setFilePreviews,
              setFileFieldValue,
              setImageFieldValue,
              setUploadProgress,
            );
          }}
          style={{ display: 'none' }}
        />
        {!isCameraOpen && hasCameraSupport && visible && (
          <div className="relative group">
            <button
              onClick={(e) => handleCameraButtonClick(e)}
              className="open-photo-button flex"
            >
              <IconCamera className="text-black dark:text-white rounded h-5 w-5 hover:bg-gray-200 dark:hover:bg-gray-700" />
              <span className="sr-only">Open Camera</span>
            </button>
            <div className="absolute left-1/2 transform -translate-x-1/2 bottom-full mb-2 hidden group-hover:block bg-black text-white text-xs py-1 px-2 rounded shadow-md">
              Enable Camera
            </div>
          </div>
        )}
        <CameraModal
          isOpen={isModalOpen}
          closeModal={closeModal}
          videoRef={videoRef}
          canvasRef={canvasRef}
          fileInputRef={fileInputRef}
          setIsCameraOpen={setIsCameraOpen}
          setFilePreviews={setFilePreviews}
          setSubmitType={setSubmitType}
          setFileFieldValue={setFileFieldValue}
          setImageFieldValue={setImageFieldValue}
          setUploadProgress={setUploadProgress}
        />
      </>
    );
  },
);

ChatInputImageCapture.displayName = 'ChatInputImageCapture';

export default ChatInputImageCapture;

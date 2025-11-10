import { IconCamera } from '@tabler/icons-react';
import React, {
  Dispatch,
  FC,
  MutableRefObject,
  SetStateAction,
  useEffect,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FilePreview,
  ImageFieldValue,
} from '@/types/chat';

import Modal from '@/components/UI/Modal';

import { onFileUpload } from '@/client/handlers/chatInput/file-upload';

const onTakePhotoButtonClick = (
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  canvasRef: MutableRefObject<HTMLCanvasElement | null>,
  fileInputRef: MutableRefObject<HTMLInputElement | null>,
  setIsCameraOpen: Dispatch<SetStateAction<boolean>>,
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>,
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>,
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>,
  setImageFieldValue: Dispatch<SetStateAction<ImageFieldValue>>,
  closeModal: () => void,
  setUploadProgress: Dispatch<SetStateAction<{ [p: string]: number }>>,
) => {
  if (videoRef.current && canvasRef.current && fileInputRef.current) {
    canvasRef.current.width = videoRef.current.videoWidth;
    canvasRef.current.height = videoRef.current.videoHeight;
    canvasRef.current.getContext('2d')?.drawImage(videoRef.current, 0, 0);

    canvasRef.current.toBlob((blob) => {
      if (blob) {
        const file = new File([blob], 'camera_image.png', {
          type: 'image/png',
        });
        // Pass the file directly as an array instead of simulating a change event
        onFileUpload(
          [file],
          setSubmitType,
          setFilePreviews,
          setFileFieldValue,
          setImageFieldValue,
          setUploadProgress,
        );
      }
    }, 'image/png');

    stopMediaStream(videoRef.current);
    setIsCameraOpen(false);
  }
  closeModal();
};

const stopMediaStream = (videoElement: HTMLVideoElement | null) => {
  if (videoElement && videoElement.srcObject instanceof MediaStream) {
    const tracks = videoElement.srcObject.getTracks();
    tracks.forEach((track) => track.stop());
  }
};

interface CameraModalProps {
  isOpen: boolean;
  closeModal: () => void;
  videoRef: MutableRefObject<HTMLVideoElement | null>;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  setIsCameraOpen: Dispatch<SetStateAction<boolean>>;
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>;
  setFileFieldValue: Dispatch<SetStateAction<FileFieldValue>>;
  setImageFieldValue: Dispatch<SetStateAction<ImageFieldValue>>;
  setUploadProgress: Dispatch<SetStateAction<{ [p: string]: number }>>;
}

export const CameraModal: FC<CameraModalProps> = ({
  isOpen,
  closeModal,
  videoRef,
  canvasRef,
  fileInputRef,
  setIsCameraOpen,
  setFilePreviews,
  setSubmitType,
  setFileFieldValue,
  setImageFieldValue,
  setUploadProgress,
}) => {
  const t = useTranslations();
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>('');

  useEffect(() => {
    // Capture the ref value at effect execution time
    const video = videoRef.current;

    const getDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(
          (device) => device.kind === 'videoinput',
        );
        setCameras(videoDevices);
        if (videoDevices.length > 0) {
          setSelectedCamera(videoDevices[0].deviceId);
          // Initialize camera with the first device when modal opens
          if (isOpen) {
            await startCamera(videoDevices[0].deviceId);
          }
        }
      } catch (error) {
        console.error('Error enumerating devices:', error);
      }
    };

    getDevices();

    // Cleanup function to stop media stream when component unmounts or modal closes
    return () => {
      if (isOpen === false) {
        stopMediaStream(video);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const startCamera = async (deviceId: string) => {
    try {
      const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (error) {
      console.error('Error starting camera:', error);
      // Show an error message to the user
      alert(
        'Could not access camera. Please check your camera permissions and try again.',
      );
      closeModal();
    }
  };

  const handleCameraChange = (deviceId: string) => {
    setSelectedCamera(deviceId);
    stopMediaStream(videoRef.current);
    startCamera(deviceId);
  };

  const exitModal = () => {
    stopMediaStream(videoRef.current);
    setIsCameraOpen(false);
    closeModal();
  };

  const modalContent = (
    <>
      {cameras.length > 1 && (
        <select
          value={selectedCamera}
          onChange={(e) => handleCameraChange(e.target.value)}
          className="mb-4 w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-800 dark:text-white"
        >
          {cameras.map((camera) => (
            <option key={camera.deviceId} value={camera.deviceId}>
              {camera.label || `Camera (${camera.deviceId})`}
            </option>
          ))}
        </select>
      )}
      {cameras.length === 1 && (
        <div className="mb-4 text-center dark:text-white text-gray-900">
          {cameras[0].label || 'Camera'}
        </div>
      )}
      <div className="relative mb-4">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="w-full h-auto rounded-md"
        />
        <canvas ref={canvasRef} style={{ display: 'none' }} />
      </div>
    </>
  );

  const modalFooter = (
    <button
      onClick={() => {
        onTakePhotoButtonClick(
          videoRef,
          canvasRef,
          fileInputRef,
          setIsCameraOpen,
          setFilePreviews,
          setSubmitType,
          setFileFieldValue,
          setImageFieldValue,
          closeModal,
          setUploadProgress,
        );
      }}
      className="w-full bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-md flex items-center justify-center"
    >
      <IconCamera className="w-6 h-6 mr-2" />
      <span>{t('Take photo')}</span>
    </button>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={exitModal}
      title={t('Camera')}
      icon={<IconCamera size={24} />}
      footer={modalFooter}
      size="md"
      className="dark:bg-gray-900"
    >
      {modalContent}
    </Modal>
  );
};

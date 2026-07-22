import { IconCamera } from '@tabler/icons-react';
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import Modal from '@/components/UI/Modal';

const stopMediaStream = (videoElement: HTMLVideoElement | null) => {
  if (videoElement && videoElement.srcObject instanceof MediaStream) {
    videoElement.srcObject.getTracks().forEach((track) => track.stop());
    videoElement.srcObject = null;
  }
};

export interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Receives the captured frame as a PNG File. */
  onCapture: (file: File) => void;
}

/**
 * Pipeline-agnostic camera capture: opens a live preview, lets the user pick
 * between cameras, and hands the captured frame back as a File. Owns the whole
 * MediaStream lifecycle — callers must not open a stream beforehand.
 */
export const CameraCaptureModal: FC<CameraCaptureModalProps> = ({
  isOpen,
  onClose,
  onCapture,
}) => {
  const t = useTranslations();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCamera, setSelectedCamera] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const startCamera = useCallback(async (deviceId?: string) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId } : true,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      } else {
        // Modal closed while permission was pending — don't leak the stream.
        stream.getTracks().forEach((track) => track.stop());
      }
      return true;
    } catch (err) {
      console.error('Error starting camera:', err);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const video = videoRef.current;
    let cancelled = false;

    const init = async () => {
      setError(null);
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(
          (device) => device.kind === 'videoinput',
        );
        if (cancelled) return;
        setCameras(videoDevices);
        const deviceId = videoDevices[0]?.deviceId;
        if (deviceId) setSelectedCamera(deviceId);
        const started = await startCamera(deviceId);
        if (!cancelled && !started) setError(t('cameraAccessError'));
      } catch (err) {
        console.error('Error enumerating devices:', err);
        if (!cancelled) setError(t('cameraAccessError'));
      }
    };

    void init();

    return () => {
      cancelled = true;
      stopMediaStream(video);
    };
  }, [isOpen, startCamera, t]);

  const handleCameraChange = async (deviceId: string) => {
    setSelectedCamera(deviceId);
    stopMediaStream(videoRef.current);
    const started = await startCamera(deviceId);
    setError(started ? null : t('cameraAccessError'));
  };

  const handleTakePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (blob) {
        onCapture(new File([blob], 'camera_image.png', { type: 'image/png' }));
      }
    }, 'image/png');

    stopMediaStream(video);
    onClose();
  };

  const exitModal = () => {
    stopMediaStream(videoRef.current);
    onClose();
  };

  const modalContent = (
    <>
      {cameras.length > 1 && (
        <select
          value={selectedCamera}
          onChange={(e) => void handleCameraChange(e.target.value)}
          aria-label={t('Camera')}
          className="mb-4 w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-800 dark:text-white"
        >
          {cameras.map((camera) => (
            <option key={camera.deviceId} value={camera.deviceId}>
              {camera.label || t('cameraUnnamedDevice')}
            </option>
          ))}
        </select>
      )}
      {cameras.length === 1 && (
        <div className="mb-4 text-center dark:text-white text-gray-900">
          {cameras[0].label || t('cameraUnnamedDevice')}
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
      {error && (
        <p className="text-sm text-red-700 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </>
  );

  const modalFooter = (
    <button
      onClick={handleTakePhoto}
      disabled={error !== null}
      className="w-full bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white px-4 py-2 rounded-md flex items-center justify-center"
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

export default CameraCaptureModal;

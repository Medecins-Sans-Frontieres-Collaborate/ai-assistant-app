import { IconPlayerRecordFilled } from '@tabler/icons-react';
import React, { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import MicIcon from '@/components/Icons/mic';

import { useChatInputStore } from '@/client/stores/chatInputStore';

const SILENCE_THRESHOLD = -50;
const MAX_SILENT_DURATION = 6000;

const ChatInputVoiceCapture: FC = React.memo(() => {
  const setTextFieldValue = useChatInputStore(
    (state) => state.setTextFieldValue,
  );
  const setIsTranscribing = useChatInputStore(
    (state) => state.setIsTranscribing,
  );
  const t = useTranslations();
  const [hasMicrophone, setHasMicrophone] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceStartTimeRef = useRef<number | null>(null);
  const checkSilenceIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    // Check for microphone availability
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const hasMic = devices.some((device) => device.kind === 'audioinput');
        setHasMicrophone(hasMic);
      })
      .catch((err) => {
        console.error('[VoiceCapture] Error accessing media devices:', err);
        setHasMicrophone(false);
      });
  }, []);

  const startRecording = async () => {
    // Check current permission status
    try {
      const permissionStatus = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });

      if (permissionStatus.state === 'denied') {
        alert(
          'Microphone access is denied. Please enable it in your browser settings.',
        );
        return;
      }
    } catch (permErr) {
      // Permissions API not supported, continue anyway
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      mediaStreamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start();

      // Empty the chunks
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: 'audio/webm',
        });
        // Send audioBlob to the API to transcribe
        transcribeAudio(audioBlob);
      };

      // Set up audio context for silence detection
      audioContextRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      const source = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.minDecibels = -90;
      analyserRef.current.maxDecibels = -10;
      analyserRef.current.smoothingTimeConstant = 0.85;

      source.connect(analyserRef.current);

      // Start checking for silence
      silenceStartTimeRef.current = null;
      checkSilenceIntervalRef.current = window.setInterval(() => {
        if (analyserRef.current) {
          const dataArray = new Uint8Array(analyserRef.current.fftSize);
          analyserRef.current.getByteTimeDomainData(dataArray);

          // Calculate RMS (Root Mean Square) to get volume level
          let sum = 0;
          for (const amplitude of dataArray) {
            const normalized = amplitude / 128 - 1;
            sum += normalized * normalized;
          }
          const rms = Math.sqrt(sum / dataArray.length);
          const db = 20 * Math.log10(rms);

          if (db < SILENCE_THRESHOLD || isNaN(db)) {
            if (silenceStartTimeRef.current === null) {
              silenceStartTimeRef.current = Date.now();
            } else {
              const silentDuration = Date.now() - silenceStartTimeRef.current;
              if (silentDuration > MAX_SILENT_DURATION) {
                // Stop recording due to silence
                stopRecording();
              }
            }
          } else {
            silenceStartTimeRef.current = null;
          }
        }
      }, 100);

      setIsRecording(true);
    } catch (err: any) {
      console.error('[VoiceCapture] Error getting user media:', err);
      console.error('[VoiceCapture] Error name:', err.name);
      console.error('[VoiceCapture] Error message:', err.message);
      alert(`Microphone access error: ${err.message}`);
    }
  };

  const stopRecording = () => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      mediaRecorderRef.current.stop();
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    if (checkSilenceIntervalRef.current) {
      clearInterval(checkSilenceIntervalRef.current);
      checkSilenceIntervalRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    silenceStartTimeRef.current = null;
    setIsRecording(false);
  };

  const transcribeAudio = async (audioBlob: Blob) => {
    setIsTranscribing(true);
    try {
      const filename = 'audio.webm';
      const mimeType = 'audio/x-matroska';

      // Encode filename and MIME type
      const encodedFileName = encodeURIComponent(filename);
      const encodedMimeType = encodeURIComponent(mimeType);

      // Convert blob to base64
      const base64Chunk = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(audioBlob);
      });

      // Remove the data URL prefix (e.g., "data:audio/webm;base64,")
      const base64Data = base64Chunk.split(',')[1];

      // Upload the audioBlob to the server
      const uploadResponse = await fetch(
        `/api/file/upload?filename=${encodedFileName}&filetype=file&mime=${encodedMimeType}`,
        {
          method: 'POST',
          body: base64Data,
          headers: {
            'x-file-name': encodedFileName,
          },
        },
      );

      if (!uploadResponse.ok) {
        throw new Error('Failed to upload audio');
      }

      const uploadResult = await uploadResponse.json();
      const fileURI = uploadResult.uri;
      const fileID = encodeURIComponent(fileURI.split('/').pop());

      // Call the transcribe endpoint
      const transcribeResponse = await fetch(`/api/file/${fileID}/transcribe`, {
        method: 'GET',
      });

      if (!transcribeResponse.ok) {
        throw new Error('Failed to transcribe audio');
      }

      const transcribeResult = await transcribeResponse.json();
      const transcript = transcribeResult.transcript;

      setTextFieldValue((prevText) =>
        prevText?.length ? prevText + ' ' + transcript : transcript,
      );
    } catch (error) {
      console.error('Error during transcription:', error);
    } finally {
      setIsTranscribing(false);
    }
  };

  if (!hasMicrophone) {
    return null; // Don't display the component if no microphones are available
  }

  return (
    <div className="voice-capture">
      {isRecording ? (
        <button
          className="flex items-center gap-2 px-3 py-2 rounded-full bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors duration-200"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            stopRecording();
          }}
          title={t('chat.clickToStopRecording')}
        >
          <IconPlayerRecordFilled className="h-5 w-5 animate-pulse text-red-500" />
          <span className="text-sm font-medium text-red-600 dark:text-red-400 whitespace-nowrap">
            Stop recording
          </span>
        </button>
      ) : (
        <div className="group relative">
          <button
            className="flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-full text-gray-600 hover:bg-gray-100/50 dark:text-gray-400 dark:hover:bg-gray-800/50 transition-colors duration-200"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              startRecording();
            }}
            aria-label={t('chat.startVoiceRecording')}
          >
            <MicIcon className="h-5 w-5 md:h-4 md:w-4" />
          </button>
          <div className="absolute left-1/2 transform -translate-x-1/2 bottom-full mb-2 hidden group-hover:block bg-black text-white text-xs py-1 px-2 rounded shadow-md whitespace-nowrap z-50">
            Voice Input
          </div>
        </div>
      )}
    </div>
  );
});

ChatInputVoiceCapture.displayName = 'ChatInputVoiceCapture';

export default ChatInputVoiceCapture;

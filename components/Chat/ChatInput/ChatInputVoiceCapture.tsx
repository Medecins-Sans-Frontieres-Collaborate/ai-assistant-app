import { IconPlayerRecordFilled } from '@tabler/icons-react';
import React, { FC, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import MicIcon from '@/components/Icons/mic';

import { useChatInputStore } from '@/client/stores/chatInputStore';

const SILENCE_THRESHOLD = -50;
const TRANSCRIBE_SILENCE_DURATION = 2000; // 2 seconds of silence triggers transcription
const MAX_SILENT_DURATION = 6000; // 6 seconds of silence stops recording
const WARMUP_MS = 2000;

/** MIME types MediaRecorder can produce; ordered by preference. */
const MIME_CANDIDATES: Array<{ mime: string; ext: string }> = [
  { mime: 'audio/webm;codecs=opus', ext: 'webm' },
  { mime: 'audio/webm', ext: 'webm' },
  { mime: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' },
  { mime: 'audio/mp4', ext: 'm4a' },
  { mime: 'audio/ogg;codecs=opus', ext: 'ogg' },
];

function pickRecorderFormat(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') {
    return null;
  }
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate.mime)) {
      return candidate;
    }
  }
  // Last resort: let the browser pick its default container.
  return { mime: '', ext: 'webm' };
}

const ChatInputVoiceCapture: FC = React.memo(() => {
  const setTextFieldValue = useChatInputStore(
    (state) => state.setTextFieldValue,
  );
  const setIsTranscribing = useChatInputStore(
    (state) => state.setIsTranscribing,
  );
  const t = useTranslations();
  const [hasMicrophone, setHasMicrophone] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribingSegment, setIsTranscribingSegment] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const lastTranscribedChunkIndexRef = useRef<number>(0);
  const recordingMimeRef = useRef<string>('audio/webm');
  const recordingExtRef = useRef<string>('webm');

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceStartTimeRef = useRef<number | null>(null);
  const checkSilenceIntervalRef = useRef<number | null>(null);
  const warmupTimeoutRef = useRef<number | null>(null);
  const isMountedRef = useRef<boolean>(true);

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

  // Release mic/stream/context/timers if the component unmounts mid-recording.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopRecording();
    };
  }, []);

  const startRecording = async () => {
    // Re-entry guard: ignore clicks while a recording is being set up or active.
    if (isInitializing || isRecording) {
      return;
    }

    // Pick a MediaRecorder MIME the current browser can actually produce.
    // Prevents construction failures on Safari where webm is unsupported.
    const format = pickRecorderFormat();
    if (!format) {
      alert(t('chat.mediaRecorderNotSupported'));
      return;
    }

    // Check current permission status
    try {
      const permissionStatus = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });

      if (permissionStatus.state === 'denied') {
        alert(t('chat.microphoneAccessDenied'));
        return;
      }
    } catch (permErr) {
      // Permissions API not supported, continue anyway
    }

    // Mark initializing *before* the async getUserMedia so subsequent clicks
    // during the permission prompt are rejected by the guard above.
    setIsInitializing(true);

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // If the component unmounted or stop was called while waiting for the
      // permission prompt, release the stream immediately.
      if (!isMountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      mediaStreamRef.current = stream;
      recordingMimeRef.current = format.mime || 'audio/webm';
      recordingExtRef.current = format.ext;

      const recorderOptions: MediaRecorderOptions | undefined = format.mime
        ? { mimeType: format.mime }
        : undefined;
      const mediaRecorder = new MediaRecorder(stream, recorderOptions);
      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(100); // Capture data every 100ms to prevent audio cutoff

      // Empty the chunks and reset transcription index
      audioChunksRef.current = [];
      lastTranscribedChunkIndexRef.current = 0;

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstart = () => {
        console.log(
          '[VoiceCapture] Recording initialized - audio capture active',
        );
      };

      mediaRecorder.onstop = () => {
        // Only transcribe remaining chunks that haven't been transcribed yet
        const remainingChunks = audioChunksRef.current.slice(
          lastTranscribedChunkIndexRef.current,
        );
        if (remainingChunks.length > 0) {
          const finalBlob = new Blob(remainingChunks, {
            type: recordingMimeRef.current,
          });
          transcribeAudio(finalBlob);
        }
      };

      // Set up audio context for silence detection
      audioContextRef.current = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      audioSourceRef.current =
        audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.minDecibels = -90;
      analyserRef.current.maxDecibels = -10;
      analyserRef.current.smoothingTimeConstant = 0.85;

      audioSourceRef.current.connect(analyserRef.current);

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

              // Trigger transcription on shorter silence (while continuing to record)
              if (
                silentDuration > TRANSCRIBE_SILENCE_DURATION &&
                !isTranscribingSegment
              ) {
                const hasUntranscribedChunks =
                  audioChunksRef.current.length >
                  lastTranscribedChunkIndexRef.current;

                if (hasUntranscribedChunks) {
                  transcribeSegment();
                  silenceStartTimeRef.current = Date.now(); // Reset timer after triggering
                }
              }

              // Stop recording on longer silence
              if (silentDuration > MAX_SILENT_DURATION) {
                stopRecording();
              }
            }
          } else {
            silenceStartTimeRef.current = null;
          }
        }
      }, 100);

      // Warmup: give the mic stream a moment to stabilize before exposing
      // the "recording" UI. Tracked by ref so stopRecording() can cancel it
      // if the user bails during the warmup window.
      // TODO: detect stream readiness rather than using a hardcoded delay
      warmupTimeoutRef.current = window.setTimeout(() => {
        warmupTimeoutRef.current = null;
        if (!isMountedRef.current) return;
        setIsInitializing(false);
        setIsRecording(true);
      }, WARMUP_MS);
    } catch (err: any) {
      console.error('[VoiceCapture] Error getting user media:', err);
      console.error('[VoiceCapture] Error name:', err.name);
      console.error('[VoiceCapture] Error message:', err.message);
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      mediaStreamRef.current = null;
      if (isMountedRef.current) {
        setIsInitializing(false);
      }
      alert(t('chat.microphoneAccessError', { message: err.message }));
    }
  };

  const stopRecording = () => {
    if (warmupTimeoutRef.current !== null) {
      clearTimeout(warmupTimeoutRef.current);
      warmupTimeoutRef.current = null;
    }
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== 'inactive'
    ) {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // MediaRecorder.stop can throw if the recorder is already inactive
        // due to a race; swallow — we're tearing down anyway.
      }
    }
    mediaRecorderRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (checkSilenceIntervalRef.current) {
      clearInterval(checkSilenceIntervalRef.current);
      checkSilenceIntervalRef.current = null;
    }
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.disconnect();
      } catch {
        // disconnect can throw if already disconnected
      }
      audioSourceRef.current = null;
    }
    analyserRef.current = null;
    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
      audioContextRef.current = null;
    }
    silenceStartTimeRef.current = null;
    if (isMountedRef.current) {
      setIsInitializing(false);
      setIsRecording(false);
    }
  };

  /**
   * Transcribe a segment of audio while continuing to record.
   * Takes chunks from lastTranscribedChunkIndex to current length.
   */
  const transcribeSegment = async () => {
    const startIndex = lastTranscribedChunkIndexRef.current;
    const endIndex = audioChunksRef.current.length;

    // Skip if no new chunks
    if (endIndex <= startIndex) return;

    // Get pending chunks
    const pendingChunks = audioChunksRef.current.slice(startIndex, endIndex);

    // Update index before async operation to prevent re-processing
    lastTranscribedChunkIndexRef.current = endIndex;

    // Create blob from pending chunks
    const segmentBlob = new Blob(pendingChunks, {
      type: recordingMimeRef.current,
    });

    // Transcribe with UI indicator
    setIsTranscribingSegment(true);
    try {
      await transcribeAudio(segmentBlob);
    } finally {
      if (isMountedRef.current) {
        setIsTranscribingSegment(false);
      }
    }
  };

  const transcribeAudio = async (audioBlob: Blob) => {
    if (isMountedRef.current) {
      setIsTranscribing(true);
    }
    try {
      const filename = `audio.${recordingExtRef.current}`;
      const mimeType =
        audioBlob.type || recordingMimeRef.current || 'audio/webm';

      const encodedFileName = encodeURIComponent(filename);
      const encodedMimeType = encodeURIComponent(mimeType);

      // Upload using FormData (binary, not base64)
      const formData = new FormData();
      formData.append('file', audioBlob, filename);

      const uploadResponse = await fetch(
        `/api/file/upload?filename=${encodedFileName}&filetype=file&mime=${encodedMimeType}`,
        {
          method: 'POST',
          body: formData,
        },
      );

      if (!uploadResponse.ok) {
        const errorData = await uploadResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to upload audio');
      }

      const uploadResult = await uploadResponse.json();
      const fileURI = uploadResult.data?.uri;

      if (!fileURI) {
        throw new Error('Failed to get file URI from upload response');
      }

      const fileID = encodeURIComponent(fileURI.split('/').pop()!);

      // Call the transcribe endpoint
      const transcribeResponse = await fetch(`/api/file/${fileID}/transcribe`, {
        method: 'GET',
      });

      if (!transcribeResponse.ok) {
        const errorData = await transcribeResponse.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to transcribe audio');
      }

      const transcribeResult = await transcribeResponse.json();

      // Voice capture audio is always small enough for synchronous transcription
      if (transcribeResult.async) {
        throw new Error(
          'Audio file too large for voice capture. Please use the file upload option for large audio files.',
        );
      }

      const transcript = transcribeResult.transcript;

      if (isMountedRef.current) {
        setTextFieldValue((prevText) =>
          prevText?.length ? prevText + ' ' + transcript : transcript,
        );
      }
    } catch (error) {
      console.error('Error during transcription:', error);
    } finally {
      if (isMountedRef.current) {
        setIsTranscribing(false);
      }
    }
  };

  if (!hasMicrophone) {
    return null; // Don't display the component if no microphones are available
  }

  return (
    <div className="voice-capture">
      {isInitializing ? (
        <button
          className="flex items-center gap-2 px-3 py-2 rounded-full bg-yellow-50 dark:bg-yellow-900/20 cursor-wait"
          disabled
        >
          <IconPlayerRecordFilled className="h-5 w-5 animate-pulse text-yellow-500" />
          <span className="text-sm font-medium text-yellow-600 dark:text-yellow-400 whitespace-nowrap">
            {t('chat.voiceInputStarting')}
          </span>
        </button>
      ) : isRecording ? (
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
          <div className="flex flex-col items-start">
            <span className="text-sm font-medium text-red-600 dark:text-red-400 whitespace-nowrap">
              {isTranscribingSegment
                ? t('chat.voiceInputTranscribing')
                : t('chat.voiceInputRecording')}
            </span>
            <span className="text-xs text-red-500 dark:text-red-400/70 whitespace-nowrap">
              {t('chat.voiceInputTapToStop')}
            </span>
          </div>
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
            {t('chat.voiceInput')}
          </div>
        </div>
      )}
    </div>
  );
});

ChatInputVoiceCapture.displayName = 'ChatInputVoiceCapture';

export default ChatInputVoiceCapture;

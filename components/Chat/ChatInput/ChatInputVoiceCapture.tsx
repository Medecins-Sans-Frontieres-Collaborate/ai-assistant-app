import { IconPlayerRecordFilled } from '@tabler/icons-react';
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import MicIcon from '@/components/Icons/mic';

import { useChatInputStore } from '@/client/stores/chatInputStore';

const SILENCE_THRESHOLD = -50;
const TRANSCRIBE_SILENCE_DURATION = 2000; // 2 seconds of silence triggers transcription
const MAX_SILENT_DURATION = 6000; // 6 seconds of silence stops recording
const WARMUP_FALLBACK_MS = 500; // Max time to wait for stream readiness
const AUDIO_LEVEL_THROTTLE_MS = 150; // Throttle audio level state updates

type MicStatus = 'unknown' | 'available' | 'unavailable' | 'denied';

const ChatInputVoiceCapture: FC = React.memo(() => {
  const setTextFieldValue = useChatInputStore(
    (state) => state.setTextFieldValue,
  );
  const setIsTranscribing = useChatInputStore(
    (state) => state.setIsTranscribing,
  );
  const t = useTranslations();
  const [micStatus, setMicStatus] = useState<MicStatus>('unknown');
  const [isInitializing, setIsInitializing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribingSegment, setIsTranscribingSegment] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const lastTranscribedChunkIndexRef = useRef<number>(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceStartTimeRef = useRef<number | null>(null);
  const checkSilenceIntervalRef = useRef<number | null>(null);
  const isWarmedUpRef = useRef(false);
  const warmupStartTimeRef = useRef<number>(0);
  const lastAudioLevelUpdateRef = useRef<number>(0);
  const isTranscribingSegmentRef = useRef(false);

  useEffect(() => {
    // Check for microphone availability
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        const hasMic = devices.some((device) => device.kind === 'audioinput');
        const hasAnyDevice = devices.length > 0;
        if (hasMic) {
          setMicStatus('available');
        } else if (hasAnyDevice) {
          // API is working and explicitly reports no audioinput devices
          setMicStatus('unavailable');
        }
        // else: zero devices returned (e.g. Firefox before permission grant) — keep 'unknown', show button
      })
      .catch((err) => {
        console.error('[VoiceCapture] Error accessing media devices:', err);
        // Keep 'unknown' — don't hide the button on enumeration failure
      });

    // Listen for permission changes to recover from 'denied' state
    // eslint-disable-next-line no-undef
    let permissionStatus: PermissionStatus | null = null;
    let handleChange: (() => void) | null = null;

    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        permissionStatus = status;
        handleChange = () => {
          if (status.state === 'granted' || status.state === 'prompt') {
            setMicStatus('available');
          } else if (status.state === 'denied') {
            setMicStatus('denied');
          }
        };
        status.addEventListener('change', handleChange);
      })
      .catch(() => {
        // Permissions API not supported in this browser
      });

    return () => {
      if (permissionStatus && handleChange) {
        permissionStatus.removeEventListener('change', handleChange);
      }
    };
  }, []);

  const stopRecording = useCallback(() => {
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
    isWarmedUpRef.current = false;
    audioChunksRef.current = [];
    lastTranscribedChunkIndexRef.current = 0;
    setIsInitializing(false);
    setIsRecording(false);
    setAudioLevel(0);
  }, []);

  // Cleanup recording resources on unmount
  useEffect(() => {
    return () => stopRecording();
  }, [stopRecording]);

  const transcribeAudio = useCallback(
    async (audioBlob: Blob) => {
      setIsTranscribing(true);
      try {
        const filename = 'audio.webm';
        const mimeType = audioBlob.type || 'audio/webm';

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
        const transcribeResponse = await fetch(
          `/api/file/${fileID}/transcribe`,
          {
            method: 'GET',
          },
        );

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

        setTextFieldValue((prevText) =>
          prevText?.length ? prevText + ' ' + transcript : transcript,
        );
      } catch (error) {
        console.error('Error during transcription:', error);
        toast.error(t('chat.voiceTranscriptionFailed'));
        throw error;
      } finally {
        setIsTranscribing(false);
      }
    },
    [setIsTranscribing, setTextFieldValue, t],
  );

  const startRecording = async () => {
    // Check current permission status
    try {
      const permissionStatus = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });

      if (permissionStatus.state === 'denied') {
        setMicStatus('denied');
        toast.error(t('chat.microphoneAccessDenied'));
        return;
      }
    } catch {
      // Permissions API not supported, continue anyway
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // If we got here, mic is available
      setMicStatus('available');

      mediaStreamRef.current = stream;
      const mediaRecorder = new MediaRecorder(stream);
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
          const finalBlob = new Blob(remainingChunks, { type: 'audio/webm' });
          transcribeAudio(finalBlob).catch(() => {});
        }
      };

      // Set up audio context for silence detection
      audioContextRef.current = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      const source = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.minDecibels = -90;
      analyserRef.current.maxDecibels = -10;
      analyserRef.current.smoothingTimeConstant = 0.85;

      source.connect(analyserRef.current);

      // Show initializing state immediately
      setIsInitializing(true);
      isWarmedUpRef.current = false;
      warmupStartTimeRef.current = Date.now();

      // Start checking for audio signal / silence
      silenceStartTimeRef.current = null;
      checkSilenceIntervalRef.current = window.setInterval(() => {
        if (!analyserRef.current) return;

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

        // Normalize audio level to 0-1 range for the visual indicator
        // Map from roughly -60dB..0dB to 0..1
        const normalizedLevel = Number.isFinite(db)
          ? Math.max(0, Math.min(1, (db + 60) / 60))
          : 0;

        // Throttle audio level state updates
        const now = Date.now();
        if (now - lastAudioLevelUpdateRef.current > AUDIO_LEVEL_THROTTLE_MS) {
          lastAudioLevelUpdateRef.current = now;
          setAudioLevel(normalizedLevel);
        }

        // Handle warmup: wait for audio signal or fallback timeout
        if (!isWarmedUpRef.current) {
          const elapsed = now - warmupStartTimeRef.current;
          const hasAudioSignal = !isNaN(db) && db > SILENCE_THRESHOLD;

          if (hasAudioSignal || elapsed >= WARMUP_FALLBACK_MS) {
            isWarmedUpRef.current = true;
            setIsInitializing(false);
            setIsRecording(true);
          }
          return; // Don't run silence detection until warmed up
        }

        // Silence detection (only runs after warmup)
        if (db < SILENCE_THRESHOLD || isNaN(db)) {
          if (silenceStartTimeRef.current === null) {
            silenceStartTimeRef.current = Date.now();
          } else {
            const silentDuration = Date.now() - silenceStartTimeRef.current;

            // Trigger transcription on shorter silence (while continuing to record)
            if (
              silentDuration > TRANSCRIBE_SILENCE_DURATION &&
              !isTranscribingSegmentRef.current
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
      }, 100);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[VoiceCapture] Error getting user media:', error);
      console.error('[VoiceCapture] Error name:', error.name);
      console.error('[VoiceCapture] Error message:', error.message);

      if (error.name === 'NotAllowedError') {
        setMicStatus('denied');
        toast.error(t('chat.microphoneAccessDenied'));
      } else {
        toast.error(
          t('chat.microphoneAccessError', { message: error.message }),
        );
      }
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
    const segmentBlob = new Blob(pendingChunks, { type: 'audio/webm' });

    // Transcribe with UI indicator
    setIsTranscribingSegment(true);
    isTranscribingSegmentRef.current = true;
    try {
      await transcribeAudio(segmentBlob);
    } catch {
      // Roll back so these chunks get retried on next silence or final stop
      lastTranscribedChunkIndexRef.current = startIndex;
    } finally {
      isTranscribingSegmentRef.current = false;
      setIsTranscribingSegment(false);
    }
  };

  // Always show button unless we're certain no mic exists (and it's not a permission issue)
  if (micStatus === 'unavailable') {
    return (
      <div className="voice-capture">
        <div className="group relative">
          <button
            className="flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-full text-gray-400 dark:text-gray-600 opacity-40 cursor-not-allowed"
            disabled
            aria-label={t('chat.microphoneNotDetected')}
          >
            <MicIcon className="h-5 w-5 md:h-4 md:w-4" />
          </button>
          <div className="absolute left-1/2 transform -translate-x-1/2 bottom-full mb-2 hidden group-hover:block bg-black text-white text-xs py-1 px-2 rounded shadow-md whitespace-nowrap z-50">
            {t('chat.microphoneNotDetected')}
          </div>
        </div>
      </div>
    );
  }

  if (micStatus === 'denied') {
    return (
      <div className="voice-capture">
        <div className="group relative">
          <button
            className="flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-full text-gray-400 dark:text-gray-600 opacity-40 cursor-not-allowed"
            disabled
            aria-label={t('chat.microphoneBlocked')}
          >
            <MicIcon className="h-5 w-5 md:h-4 md:w-4" />
          </button>
          <div className="absolute left-1/2 transform -translate-x-1/2 bottom-full mb-2 hidden group-hover:block bg-black text-white text-xs py-1 px-2 rounded shadow-md whitespace-nowrap z-50">
            {t('chat.microphoneBlocked')}
          </div>
        </div>
      </div>
    );
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
            {/* Audio level indicator */}
            <div className="w-full h-1 bg-red-200 dark:bg-red-900/40 rounded-full mt-0.5 overflow-hidden">
              <div
                className="h-full bg-red-500 rounded-full transition-all duration-100"
                style={{ width: `${Math.max(audioLevel * 100, 3)}%` }}
              />
            </div>
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

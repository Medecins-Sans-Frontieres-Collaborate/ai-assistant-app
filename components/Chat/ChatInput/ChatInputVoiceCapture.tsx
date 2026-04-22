import { IconPlayerRecordFilled } from '@tabler/icons-react';
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import MicIcon from '@/components/Icons/mic';

import { useChatInputStore } from '@/client/stores/chatInputStore';

const SILENCE_THRESHOLD = -50;
const SILENCE_AUTO_STOP_MS = 10_000; // Auto-stop after this much continuous silence
const WARMUP_FALLBACK_MS = 500; // Max time to wait for stream readiness
const WARMUP_REQUIRED_FRAMES = 3; // Consecutive above-threshold frames (~300ms) to confirm signal
const AUDIO_LEVEL_THROTTLE_MS = 150; // Throttle audio level state updates

// Ordered by preference; first supported wins. Azure Whisper accepts all of these.
const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

const filenameForMime = (mimeType: string): string => {
  if (mimeType.startsWith('audio/webm')) return 'audio.webm';
  if (mimeType.startsWith('audio/mp4')) return 'audio.mp4';
  if (mimeType.startsWith('audio/ogg')) return 'audio.ogg';
  return 'audio.webm';
};

const pickSupportedMimeType = (): string => {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
};

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
  const [audioLevel, setAudioLevel] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recorderMimeTypeRef = useRef<string>('');

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceStartTimeRef = useRef<number | null>(null);
  const checkSilenceIntervalRef = useRef<number | null>(null);
  const isWarmedUpRef = useRef(false);
  const warmupStartTimeRef = useRef<number>(0);
  const warmupSignalFramesRef = useRef<number>(0);
  const lastAudioLevelUpdateRef = useRef<number>(0);
  const isStartingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    const refreshDevices = () => {
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          if (!isMountedRef.current) return;
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
          // Keep current status — don't hide the button on enumeration failure
        });
    };

    refreshDevices();
    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

    // Listen for permission changes to recover from 'denied' state
    // eslint-disable-next-line no-undef
    let permissionStatus: PermissionStatus | null = null;
    let handleChange: (() => void) | null = null;

    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (!isMountedRef.current) return;
        permissionStatus = status;
        handleChange = () => {
          if (!isMountedRef.current) return;
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
      isMountedRef.current = false;
      navigator.mediaDevices.removeEventListener(
        'devicechange',
        refreshDevices,
      );
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
    mediaRecorderRef.current = null;
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    mediaStreamRef.current = null;
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
    warmupSignalFramesRef.current = 0;
    isStartingRef.current = false;
    setIsInitializing(false);
    setIsRecording(false);
    setAudioLevel(0);
  }, []);

  // Cleanup recording resources and abort any in-flight transcription on unmount.
  useEffect(() => {
    return () => {
      stopRecording();
      abortControllerRef.current?.abort();
      // Ensure the global isTranscribing flag does not stick if we unmount mid-request.
      setIsTranscribing(false);
    };
  }, [stopRecording, setIsTranscribing]);

  const transcribeAudio = useCallback(
    async (audioBlob: Blob) => {
      const controller = new AbortController();
      abortControllerRef.current?.abort();
      abortControllerRef.current = controller;
      setIsTranscribing(true);
      try {
        const mimeType =
          audioBlob.type || recorderMimeTypeRef.current || 'audio/webm';
        const filename = filenameForMime(mimeType);

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
            signal: controller.signal,
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
            signal: controller.signal,
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

        if (!isMountedRef.current) return;
        setTextFieldValue((prevText) =>
          prevText?.length ? prevText + ' ' + transcript : transcript,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('[VoiceCapture] Error during transcription:', error);
        if (isMountedRef.current) {
          toast.error(t('chat.voiceTranscriptionFailed'));
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (isMountedRef.current) {
          setIsTranscribing(false);
        }
      }
    },
    [setIsTranscribing, setTextFieldValue, t],
  );

  const startRecording = async () => {
    // Guard against double-invocation while getUserMedia is awaiting.
    if (isStartingRef.current || isRecording || isInitializing) return;
    isStartingRef.current = true;

    // Check current permission status
    try {
      const permissionStatus = await navigator.permissions.query({
        name: 'microphone' as PermissionName,
      });

      if (permissionStatus.state === 'denied') {
        setMicStatus('denied');
        toast.error(t('chat.microphoneAccessDenied'));
        isStartingRef.current = false;
        return;
      }
    } catch {
      // Permissions API not supported, continue anyway
    }

    let acquiredStream: MediaStream | null = null;
    try {
      acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      // If we got here, mic is available
      setMicStatus('available');

      mediaStreamRef.current = acquiredStream;
      const mimeType = pickSupportedMimeType();
      const mediaRecorder = mimeType
        ? new MediaRecorder(acquiredStream, { mimeType })
        : new MediaRecorder(acquiredStream);
      recorderMimeTypeRef.current = mediaRecorder.mimeType || mimeType;
      mediaRecorderRef.current = mediaRecorder;

      // Per-recording chunks: avoids races when a new recording starts before
      // the previous recorder's onstop fires.
      const chunks: Blob[] = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        if (!isMountedRef.current) return;
        if (chunks.length === 0) return;
        const finalBlob = new Blob(chunks, {
          type: recorderMimeTypeRef.current || 'audio/webm',
        });
        transcribeAudio(finalBlob);
      };

      mediaRecorder.onerror = (event: Event) => {
        const err = (
          event as unknown as { error?: { name?: string; message?: string } }
        ).error;
        const message = err?.message || err?.name || 'unknown';
        console.error('[VoiceCapture] MediaRecorder error:', err || event);
        stopRecording();
        if (isMountedRef.current) {
          toast.error(t('chat.microphoneAccessError', { message }));
        }
      };

      mediaRecorder.start(100); // Capture data every 100ms to prevent audio cutoff

      // Set up audio context for silence detection
      audioContextRef.current = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      const source =
        audioContextRef.current.createMediaStreamSource(acquiredStream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.minDecibels = -90;
      analyserRef.current.maxDecibels = -10;
      analyserRef.current.smoothingTimeConstant = 0.85;

      source.connect(analyserRef.current);

      // Show initializing state immediately
      setIsInitializing(true);
      isWarmedUpRef.current = false;
      warmupStartTimeRef.current = Date.now();
      warmupSignalFramesRef.current = 0;

      // Successful setup — clear the starting guard; warmup takes over from here.
      isStartingRef.current = false;

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
        const dbFinite = Number.isFinite(db);

        // Normalize audio level to 0-1 range for the visual indicator
        // Map from roughly -60dB..0dB to 0..1
        const normalizedLevel = dbFinite
          ? Math.max(0, Math.min(1, (db + 60) / 60))
          : 0;

        // Throttle audio level state updates
        const now = Date.now();
        if (now - lastAudioLevelUpdateRef.current > AUDIO_LEVEL_THROTTLE_MS) {
          lastAudioLevelUpdateRef.current = now;
          setAudioLevel(normalizedLevel);
        }

        const isSignal = dbFinite && db > SILENCE_THRESHOLD;

        // Warmup: require sustained signal so a single-frame transient
        // (mic click, pop, door slam) does not flip the state. Fall back
        // to a time budget so a genuinely silent start still proceeds.
        if (!isWarmedUpRef.current) {
          if (isSignal) {
            warmupSignalFramesRef.current += 1;
          } else {
            warmupSignalFramesRef.current = 0;
          }
          const elapsed = now - warmupStartTimeRef.current;
          const sustained =
            warmupSignalFramesRef.current >= WARMUP_REQUIRED_FRAMES;
          if (sustained || elapsed >= WARMUP_FALLBACK_MS) {
            isWarmedUpRef.current = true;
            setIsInitializing(false);
            setIsRecording(true);
          }
          return; // Don't run silence detection until warmed up
        }

        // Silence detection (only runs after warmup)
        if (!isSignal) {
          if (silenceStartTimeRef.current === null) {
            silenceStartTimeRef.current = now;
          } else if (now - silenceStartTimeRef.current > SILENCE_AUTO_STOP_MS) {
            stopRecording();
          }
        } else {
          silenceStartTimeRef.current = null;
        }
      }, 100);
    } catch (err: unknown) {
      isStartingRef.current = false;
      // If getUserMedia succeeded but a downstream step (MediaRecorder
      // construction, AudioContext creation, etc.) threw, the mic stream is
      // still live. Release it directly in case it wasn't assigned to the ref.
      if (acquiredStream) {
        acquiredStream.getTracks().forEach((track) => track.stop());
      }
      stopRecording();
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[VoiceCapture] Error getting user media:', error);

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

  // Always show button unless we're certain no mic exists (and it's not a permission issue)
  if (micStatus === 'unavailable' || micStatus === 'denied') {
    const messageKey =
      micStatus === 'denied'
        ? 'chat.microphoneBlocked'
        : 'chat.microphoneNotDetected';
    return (
      <div className="voice-capture">
        <div className="group relative">
          <button
            className="flex items-center justify-center w-11 h-11 md:w-10 md:h-10 rounded-full text-gray-400 dark:text-gray-600 opacity-40 cursor-not-allowed"
            disabled
            aria-label={t(messageKey)}
          >
            <MicIcon className="h-5 w-5 md:h-4 md:w-4" />
          </button>
          <div className="absolute left-1/2 transform -translate-x-1/2 bottom-full mb-2 hidden group-hover:block bg-black text-white text-xs py-1 px-2 rounded shadow-md whitespace-nowrap z-50">
            {t(messageKey)}
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
              {t('chat.voiceInputRecording')}
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

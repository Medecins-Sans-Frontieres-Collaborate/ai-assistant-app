import { IconDownload, IconX } from '@tabler/icons-react';
import React, { useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { AudioTimeDisplay } from './Audio/AudioTimeDisplay';
import { PlaybackButton } from './Audio/PlaybackButton';
import { ProgressBar } from './Audio/ProgressBar';
import { SpeedControl } from './Audio/SpeedControl';

interface AudioPlayerProps {
  audioUrl: string;
  onClose: () => void;
}

const AudioPlayer: React.FC<AudioPlayerProps> = ({ audioUrl, onClose }) => {
  const t = useTranslations();
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [audioDuration, setAudioDuration] = useState<number>(0);
  const [audioProgress, setAudioProgress] = useState<number>(0);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [showSpeedDropdown, setShowSpeedDropdown] = useState<boolean>(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Available playback speeds
  const speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];

  // Clean up resources when component unmounts
  useEffect(() => {
    // Auto-play the audio when component mounts
    if (audioRef.current) {
      // Set up initial animation loop regardless of auto-play status
      // This ensures UI updates even if autoplay is blocked
      startAnimationLoop();

      audioRef.current
        .play()
        .then(() => {
          setIsPlaying(true);
        })
        .catch((err) => {
          console.error('Failed to autoplay audio:', err);
        });
    }

    return () => {
      stopAnimationLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start animation loop for progress updates
  const startAnimationLoop = () => {
    // First ensure any existing loop is stopped to prevent multiple loops
    stopAnimationLoop();

    // Check if audio element exists
    if (!audioRef.current) return;

    // Define animation function
    const animate = () => {
      // Safety check for audio element
      if (!audioRef.current) {
        stopAnimationLoop();
        return;
      }

      // Update the progress state - only if playing
      if (audioRef.current && !audioRef.current.paused) {
        updateProgress();
      }

      // Schedule the next frame - always continue the loop
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    // Start the animation loop immediately
    animationFrameRef.current = requestAnimationFrame(animate);
  };

  // Stop animation loop
  const stopAnimationLoop = () => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  // Update progress bar during playback
  const updateProgress = () => {
    if (!audioRef.current) return;

    // Get current time and duration
    const currentTime = audioRef.current.currentTime;
    const duration = audioRef.current.duration;

    if (isNaN(duration) || duration === 0) return; // Check if duration is valid

    // Calculate progress percentage
    const progress = (currentTime / duration) * 100;

    // Always update during playback - optimizing this too much can cause visual glitches
    setAudioProgress(progress);
  };

  // Toggle play/pause
  const togglePlayback = () => {
    if (!audioRef.current) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current
        .play()
        .then(() => {
          // Explicit restart of animation loop on play
          startAnimationLoop();
        })
        .catch((err) => {
          console.error('Failed to play audio:', err);
        });
    }
  };

  // Seek to position in audio when progress bar is clicked
  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current) return;

    const progressBar = e.currentTarget;
    const rect = progressBar.getBoundingClientRect();
    const clickPosition = (e.clientX - rect.left) / rect.width;

    // Calculate the new time position
    const newTime = clickPosition * audioRef.current.duration;

    // Set the new time
    audioRef.current.currentTime = newTime;

    // Update progress immediately for better UX
    setAudioProgress(clickPosition * 100);

    // Restart the animation loop if the audio is playing
    if (isPlaying) {
      stopAnimationLoop();
      startAnimationLoop();
    } else {
      // If paused and we seek, we still want to update the UI once
      updateProgress();
    }
  };

  // Handle audio end
  const handleAudioEnd = () => {
    setIsPlaying(false);
    setAudioProgress(0);
    stopAnimationLoop();
  };

  // Setup audio metadata when loaded
  const handleAudioLoad = () => {
    if (!audioRef.current) return;
    setAudioDuration(audioRef.current.duration);
  };

  // Effect to force time display updates even if progress isn't changing
  // This ensures the time display updates even when progress calculation has small differences
  useEffect(() => {
    let animationFrameId: number;
    const updateProgress = () => {
      if (audioRef.current) {
        setAudioProgress((prev) => {
          const currentTime = audioRef.current?.currentTime || 0;
          const duration = audioRef.current?.duration || 1;
          const exactProgress = (currentTime / duration) * 100;
          // Only update if the difference is significant
          if (Math.abs(exactProgress - prev) > 0.5) {
            return exactProgress;
          }
          return prev;
        });
      }
      animationFrameId = requestAnimationFrame(updateProgress);
    };
    if (isPlaying) {
      animationFrameId = requestAnimationFrame(updateProgress);
    }
    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying]);

  // Toggle speed dropdown visibility
  const toggleSpeedDropdown = () => {
    setShowSpeedDropdown(!showSpeedDropdown);
  };

  // Change playback speed
  const changePlaybackSpeed = (speed: number) => {
    if (!audioRef.current) return;

    // Update playback speed
    setPlaybackSpeed(speed);
    audioRef.current.playbackRate = speed;

    // If currently playing, restart the animation loop to adapt to the new speed
    if (isPlaying) {
      stopAnimationLoop();
      startAnimationLoop();
    }

    setShowSpeedDropdown(false);
  };

  // Download audio file
  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = 'assistant-audio.mp3';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="mb-4 rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-3">
      {/* Hidden native audio element for functionality */}
      <audio
        ref={audioRef}
        src={audioUrl}
        onPlay={() => {
          setIsPlaying(true);
          startAnimationLoop();
        }}
        onPause={() => {
          setIsPlaying(false);
          stopAnimationLoop();
        }}
        onEnded={handleAudioEnd}
        onLoadedMetadata={handleAudioLoad}
        onSeeked={() => {
          // Ensure animation continues after seeking
          if (isPlaying) {
            stopAnimationLoop();
            startAnimationLoop();
          }
        }}
        className="hidden"
      />

      {/* Custom audio player UI */}
      <div className="flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center">
            <PlaybackButton isPlaying={isPlaying} onToggle={togglePlayback} />
            <AudioTimeDisplay
              currentTime={audioRef.current?.currentTime || 0}
              duration={audioDuration}
              playbackSpeed={playbackSpeed}
            />
          </div>

          <div className="flex items-center">
            <SpeedControl
              playbackSpeed={playbackSpeed}
              speeds={speeds}
              showDropdown={showSpeedDropdown}
              onToggleDropdown={toggleSpeedDropdown}
              onChangeSpeed={changePlaybackSpeed}
              onClickOutside={() => setShowSpeedDropdown(false)}
            />

            {/* Download button */}
            <button
              onClick={handleDownload}
              className="mx-1 p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none"
              aria-label={t('chat.downloadAudio')}
              title={t('chat.downloadAudio')}
            >
              <IconDownload size={18} />
            </button>

            {/* Close button */}
            <button
              onClick={onClose}
              className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 focus:outline-none"
              aria-label={t('chat.closeAudioPlayer')}
              title={t('chat.closeAudioPlayer')}
            >
              <IconX size={18} />
            </button>
          </div>
        </div>

        <ProgressBar progress={audioProgress} onSeek={handleSeek} />
      </div>
    </div>
  );
};

export default AudioPlayer;

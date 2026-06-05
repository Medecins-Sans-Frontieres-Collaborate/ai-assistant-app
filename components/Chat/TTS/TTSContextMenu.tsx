'use client';

import {
  IconGenderFemale,
  IconGenderMale,
  IconVolume,
} from '@tabler/icons-react';
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import { useSettings } from '@/client/hooks/settings/useSettings';

import { TTSSettings, TTS_CONSTRAINTS, VoiceInfo } from '@/types/tts';

import {
  getBaseLanguageCode,
  getDefaultVoiceForLocale,
  getTTSLocaleForAppLocale,
  getVoicesForLocale,
  resolveVoiceForLanguage,
} from '@/lib/data/ttsVoices';

interface TTSContextMenuProps {
  /** Position of the context menu */
  position: { x: number; y: number };
  /** Callback when menu should close */
  onClose: () => void;
  /** Callback when TTS should be triggered with settings */
  onTriggerTTS: (settings: Partial<TTSSettings>) => void;
}

/**
 * Context menu for quick TTS settings overrides.
 * Appears on right-click of the TTS icon.
 */
export const TTSContextMenu: FC<TTSContextMenuProps> = ({
  position,
  onClose,
  onTriggerTTS,
}) => {
  const t = useTranslations();
  const locale = useLocale();
  const menuRef = useRef<HTMLDivElement>(null);
  const { ttsSettings } = useSettings();

  // Local state for temporary overrides
  const [overrideVoice, setOverrideVoice] = useState<string | undefined>(
    undefined,
  );
  const [overrideRate, setOverrideRate] = useState<number>(ttsSettings.rate);
  const [overridePitch, setOverridePitch] = useState<number>(ttsSettings.pitch);

  // Get TTS locale and voices
  const ttsLocale = useMemo(() => getTTSLocaleForAppLocale(locale), [locale]);
  const voices = useMemo(() => getVoicesForLocale(ttsLocale), [ttsLocale]);

  // Get effective voice name using the new settings hierarchy
  const effectiveVoiceName = useMemo(() => {
    if (overrideVoice) return overrideVoice;
    // Use the resolve function which checks languageVoices -> globalVoice -> default
    const baseLanguage = getBaseLanguageCode(ttsLocale);
    return resolveVoiceForLanguage(baseLanguage, ttsSettings);
  }, [overrideVoice, ttsSettings, ttsLocale]);

  // Close menu on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust menu position to stay within viewport
  const adjustedPosition = useMemo(() => {
    const menuWidth = 280;
    const menuHeight = 350;
    const padding = 10;

    let x = position.x;
    let y = position.y;

    // Adjust horizontal position
    if (x + menuWidth > window.innerWidth - padding) {
      x = window.innerWidth - menuWidth - padding;
    }
    if (x < padding) {
      x = padding;
    }

    // Adjust vertical position
    if (y + menuHeight > window.innerHeight - padding) {
      y = window.innerHeight - menuHeight - padding;
    }
    if (y < padding) {
      y = padding;
    }

    return { x, y };
  }, [position]);

  // Handle speak with overrides
  const handleSpeak = useCallback(() => {
    const overrides: Partial<TTSSettings> = {};

    if (overrideVoice) {
      overrides.globalVoice = overrideVoice;
    }
    if (overrideRate !== ttsSettings.rate) {
      overrides.rate = overrideRate;
    }
    if (overridePitch !== ttsSettings.pitch) {
      overrides.pitch = overridePitch;
    }

    onTriggerTTS(overrides);
    onClose();
  }, [
    overrideVoice,
    overrideRate,
    overridePitch,
    ttsSettings,
    onTriggerTTS,
    onClose,
  ]);

  // Get gender icon
  const getGenderIcon = (gender: VoiceInfo['gender']) => {
    switch (gender) {
      case 'Female':
        return <IconGenderFemale size={12} className="text-pink-500" />;
      case 'Male':
        return <IconGenderMale size={12} className="text-blue-500" />;
      default:
        return null;
    }
  };

  // Format rate for display
  const formatRate = (rate: number): string => `${rate.toFixed(1)}x`;

  // Format pitch for display
  const formatPitch = (pitch: number): string => {
    if (pitch === 0) return t('settings.tts.default');
    return pitch > 0 ? `+${pitch}%` : `${pitch}%`;
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-72 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-2"
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100">
          <IconVolume size={16} />
          {t('settings.tts.quickSettings')}
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('settings.tts.overrideForThisMessage')}
        </p>
      </div>

      {/* Voice Quick Select */}
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 block">
          {t('settings.tts.voice')}
        </label>
        <div className="max-h-32 overflow-y-auto">
          {voices.slice(0, 8).map((voice) => (
            <button
              key={voice.name}
              onClick={() => setOverrideVoice(voice.name)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 text-left rounded transition-colors text-sm ${
                effectiveVoiceName === voice.name
                  ? 'bg-gray-100 dark:bg-gray-700'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-700/50'
              }`}
            >
              {getGenderIcon(voice.gender)}
              <span className="flex-1 text-gray-900 dark:text-gray-100 truncate">
                {voice.displayName}
              </span>
              {effectiveVoiceName === voice.name && (
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Rate Slider */}
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
            {t('settings.tts.rate')}
          </label>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {formatRate(overrideRate)}
          </span>
        </div>
        <input
          type="range"
          min={TTS_CONSTRAINTS.rate.min}
          max={TTS_CONSTRAINTS.rate.max}
          step={TTS_CONSTRAINTS.rate.step}
          value={overrideRate}
          onChange={(e) => setOverrideRate(parseFloat(e.target.value))}
          className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-gray-600 dark:accent-gray-400"
        />
      </div>

      {/* Pitch Slider */}
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
            {t('settings.tts.pitch')}
          </label>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {formatPitch(overridePitch)}
          </span>
        </div>
        <input
          type="range"
          min={TTS_CONSTRAINTS.pitch.min}
          max={TTS_CONSTRAINTS.pitch.max}
          step={TTS_CONSTRAINTS.pitch.step}
          value={overridePitch}
          onChange={(e) => setOverridePitch(parseInt(e.target.value, 10))}
          className="w-full h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-gray-600 dark:accent-gray-400"
        />
      </div>

      {/* Action Button */}
      <div className="px-3 pt-2">
        <button
          onClick={handleSpeak}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-white bg-gray-800 dark:bg-gray-600 rounded-lg hover:bg-gray-700 dark:hover:bg-gray-500 transition-colors"
        >
          <IconVolume size={16} />
          {t('settings.tts.speakWithSettings')}
        </button>
      </div>
    </div>
  );
};

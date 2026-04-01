'use client';

import { IconRefresh } from '@tabler/icons-react';
import { FC, useCallback, useState } from 'react';

import { useLocale, useTranslations } from 'next-intl';

import {
  DEFAULT_TTS_SETTINGS,
  OUTPUT_FORMAT_LABELS,
  TTSOutputFormat,
  TTSSettings,
  TTS_CONSTRAINTS,
} from '@/types/tts';

import { VoiceBrowser } from './VoiceBrowser';

import {
  getBaseLanguageCode,
  getTTSLocaleForAppLocale,
  resolveVoiceForLanguage,
} from '@/lib/data/ttsVoices';

interface TTSSettingsPanelProps {
  /** Current TTS settings (from local state) */
  settings: TTSSettings;
  /** Callback when settings change */
  onChange: (settings: Partial<TTSSettings>) => void;
}

/**
 * TTS Settings Panel component.
 * Provides controls for voice selection, rate, pitch, and audio quality.
 * Supports per-language voice defaults with per-voice preview.
 */
export const TTSSettingsPanel: FC<TTSSettingsPanelProps> = ({
  settings,
  onChange,
}) => {
  const t = useTranslations();
  const locale = useLocale();
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Get effective voice name using resolve logic
  const ttsLocale = getTTSLocaleForAppLocale(locale);
  const baseLanguage = getBaseLanguageCode(ttsLocale);
  const effectiveVoiceName = resolveVoiceForLanguage(baseLanguage, settings);

  // Handle voice selection - sets as language default or global
  const handleVoiceChange = useCallback(
    (voiceName: string) => {
      // Extract base language from the voice locale and set as language default
      const voiceLocale = voiceName.match(/^([a-z]{2})-[A-Z]{2}/)?.[1];
      if (voiceLocale) {
        onChange({
          languageVoices: {
            ...settings.languageVoices,
            [voiceLocale.toLowerCase()]: voiceName,
          },
        });
      } else {
        // For voices without standard locale pattern, set as global
        onChange({ globalVoice: voiceName });
      }
    },
    [onChange, settings.languageVoices],
  );

  // Handle per-voice preview
  const handlePreviewVoice = useCallback(
    async (voiceName: string, sampleText: string) => {
      setPreviewingVoice(voiceName);
      setPreviewError(null);

      try {
        const response = await fetch('/api/chat/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: sampleText,
            voiceName: voiceName,
            rate: settings.rate,
            pitch: settings.pitch,
            outputFormat: settings.outputFormat,
          }),
        });

        if (!response.ok) {
          throw new Error(t('settings.tts.previewFailed'));
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        audio.onended = () => {
          URL.revokeObjectURL(url);
          setPreviewingVoice(null);
        };

        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setPreviewingVoice(null);
          setPreviewError(t('settings.tts.previewFailed'));
        };

        await audio.play();
      } catch (error) {
        console.error('TTS preview error:', error);
        setPreviewingVoice(null);
        setPreviewError(
          error instanceof Error
            ? error.message
            : t('settings.tts.previewFailed'),
        );
      }
    },
    [settings, t],
  );

  // Handle rate change
  const handleRateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const rate = parseFloat(e.target.value);
      onChange({ rate });
    },
    [onChange],
  );

  // Handle pitch change
  const handlePitchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const pitch = parseInt(e.target.value, 10);
      onChange({ pitch });
    },
    [onChange],
  );

  // Handle output format change
  const handleFormatChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const outputFormat = e.target.value as TTSOutputFormat;
      onChange({ outputFormat });
    },
    [onChange],
  );

  // Reset to defaults
  const handleReset = useCallback(() => {
    onChange(DEFAULT_TTS_SETTINGS);
  }, [onChange]);

  // Format rate for display
  const formatRate = (rate: number): string => {
    return `${rate.toFixed(1)}x`;
  };

  // Format pitch for display
  const formatPitch = (pitch: number): string => {
    if (pitch === 0) return t('settings.tts.default');
    return pitch > 0 ? `+${pitch}%` : `${pitch}%`;
  };

  return (
    <div className="space-y-6">
      {/* Voice Browser with per-voice preview */}
      <VoiceBrowser
        selectedVoice={effectiveVoiceName}
        onSelectVoice={handleVoiceChange}
        appLocale={locale}
        onPreviewVoice={handlePreviewVoice}
        previewingVoice={previewingVoice}
      />

      {/* Preview Error */}
      {previewError && (
        <p className="text-sm text-red-600 dark:text-red-400">{previewError}</p>
      )}

      {/* Speech Rate */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-black dark:text-gray-200">
            {t('settings.tts.rate')}
          </label>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {formatRate(settings.rate)}
          </span>
        </div>
        <input
          type="range"
          min={TTS_CONSTRAINTS.rate.min}
          max={TTS_CONSTRAINTS.rate.max}
          step={TTS_CONSTRAINTS.rate.step}
          value={settings.rate}
          onChange={handleRateChange}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-gray-600 dark:accent-gray-400"
        />
        <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-1">
          <span>{t('settings.tts.slower')}</span>
          <span>{t('settings.tts.faster')}</span>
        </div>
      </div>

      {/* Pitch */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-black dark:text-gray-200">
            {t('settings.tts.pitch')}
          </label>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {formatPitch(settings.pitch)}
          </span>
        </div>
        <input
          type="range"
          min={TTS_CONSTRAINTS.pitch.min}
          max={TTS_CONSTRAINTS.pitch.max}
          step={TTS_CONSTRAINTS.pitch.step}
          value={settings.pitch}
          onChange={handlePitchChange}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700 accent-gray-600 dark:accent-gray-400"
        />
        <div className="flex justify-between text-xs text-gray-400 dark:text-gray-500 mt-1">
          <span>{t('settings.tts.lower')}</span>
          <span>{t('settings.tts.higher')}</span>
        </div>
      </div>

      {/* Audio Quality */}
      <div>
        <label className="text-sm font-medium text-black dark:text-gray-200 mb-2 block">
          {t('settings.tts.quality')}
        </label>
        <select
          value={settings.outputFormat}
          onChange={handleFormatChange}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          {(Object.keys(OUTPUT_FORMAT_LABELS) as TTSOutputFormat[]).map(
            (format) => (
              <option key={format} value={format}>
                {OUTPUT_FORMAT_LABELS[format]}
              </option>
            ),
          )}
        </select>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
          {t('settings.tts.qualityDescription')}
        </p>
      </div>

      {/* Reset Button */}
      <div className="flex items-center gap-3 pt-2">
        <button
          onClick={handleReset}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-lg dark:text-gray-400 dark:hover:text-gray-200"
        >
          <IconRefresh size={16} />
          {t('settings.tts.reset')}
        </button>
      </div>
    </div>
  );
};

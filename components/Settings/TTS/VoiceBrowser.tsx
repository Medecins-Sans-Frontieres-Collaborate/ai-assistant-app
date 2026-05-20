'use client';

import { IconLanguage, IconVolume } from '@tabler/icons-react';
import { FC, useCallback, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { VoiceInfo } from '@/types/tts';

import { VoiceRow } from './VoiceRow';

import {
  MULTILINGUAL_VOICES,
  TTS_BASE_LANGUAGES,
  getBaseLanguageCode,
  getPreviewSampleForLanguage,
  getRegionCode,
  getVoicesForLanguageWithMultilingual,
} from '@/lib/data/ttsVoices';

interface VoiceBrowserProps {
  /** Currently selected voice name */
  selectedVoice: string;
  /** Callback when a voice is selected */
  onSelectVoice: (voiceName: string) => void;
  /** Current app locale for default language selection */
  appLocale?: string;
  /** Callback for voice preview (optional - if not provided, preview buttons hidden) */
  onPreviewVoice?: (voiceName: string, sampleText: string) => void;
  /** Voice currently being previewed (for loading state) */
  previewingVoice?: string | null;
}

/**
 * Voice browser component for selecting TTS voices.
 * Provides a single language dropdown with all regional voice variants.
 * Multilingual voices appear at the top of every language's voice list.
 */
export const VoiceBrowser: FC<VoiceBrowserProps> = ({
  selectedVoice,
  onSelectVoice,
  appLocale = 'en',
  onPreviewVoice,
  previewingVoice = null,
}) => {
  const t = useTranslations();

  // Extract base language from selected voice (e.g., "en" from "en-US-AriaNeural")
  const getLanguageFromVoice = useCallback(
    (voiceName: string): string => {
      // Check if it's a multilingual voice (they all start with en-US but work for all languages)
      const isMultilingual = MULTILINGUAL_VOICES.some(
        (v) => v.name === voiceName,
      );
      if (isMultilingual) {
        // For multilingual voices, use the app locale as the language
        return appLocale.split('-')[0].toLowerCase();
      }

      const match = voiceName.match(/^([a-z]{2})-[A-Z]{2}/);
      return match ? match[1].toLowerCase() : 'en';
    },
    [appLocale],
  );

  // Determine initial language based on selected voice or app locale
  const initialLanguage = useMemo(() => {
    if (selectedVoice) {
      return getLanguageFromVoice(selectedVoice);
    }
    return appLocale.split('-')[0].toLowerCase();
  }, [selectedVoice, appLocale, getLanguageFromVoice]);

  const [selectedLanguage, setSelectedLanguage] = useState(initialLanguage);

  // Get voices for the selected language (includes multilingual + language-specific)
  const { multilingualVoices, languageVoices } = useMemo(
    () => getVoicesForLanguageWithMultilingual(selectedLanguage),
    [selectedLanguage],
  );

  // Get language display info
  const selectedLanguageInfo = useMemo(() => {
    return TTS_BASE_LANGUAGES.find(
      (lang) => lang.code.toLowerCase() === selectedLanguage.toLowerCase(),
    );
  }, [selectedLanguage]);

  // Handle language change
  const handleLanguageChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newLanguage = e.target.value;
      setSelectedLanguage(newLanguage);

      // Auto-select first voice of new language if current voice is from different language
      const currentVoiceLang = getLanguageFromVoice(selectedVoice);
      if (currentVoiceLang !== newLanguage) {
        // Get voices for new language
        const { languageVoices: newVoices } =
          getVoicesForLanguageWithMultilingual(newLanguage);
        if (newVoices.length > 0) {
          onSelectVoice(newVoices[0].name);
        } else if (MULTILINGUAL_VOICES.length > 0) {
          onSelectVoice(MULTILINGUAL_VOICES[0].name);
        }
      }
    },
    [selectedVoice, onSelectVoice, getLanguageFromVoice],
  );

  // Handle voice preview
  const handlePreviewVoice = useCallback(
    (voice: VoiceInfo) => {
      if (onPreviewVoice) {
        // Get appropriate sample text for the voice's language
        const voiceLang = getBaseLanguageCode(voice.locale);
        const sampleText = getPreviewSampleForLanguage(
          voice.type === 'Multilingual' ? selectedLanguage : voiceLang,
        );
        onPreviewVoice(voice.name, sampleText);
      }
    },
    [onPreviewVoice, selectedLanguage],
  );

  return (
    <div className="space-y-4">
      {/* Language Selector */}
      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-black dark:text-gray-200 mb-2">
          <IconLanguage size={16} />
          {t('settings.tts.language')}
        </label>
        <select
          value={selectedLanguage}
          onChange={handleLanguageChange}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
        >
          {TTS_BASE_LANGUAGES.map((lang) => (
            <option key={lang.code} value={lang.code}>
              {lang.displayName} ({lang.nativeName})
            </option>
          ))}
        </select>
      </div>

      {/* Voice Selector */}
      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-black dark:text-gray-200 mb-2">
          <IconVolume size={16} />
          {t('settings.tts.voice')}
        </label>

        {/* Voice List */}
        <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-600">
          {/* Multilingual Voices Section */}
          {multilingualVoices.length > 0 && (
            <>
              <div className="px-3 py-1.5 bg-purple-50 dark:bg-purple-900/20 text-xs font-medium text-purple-700 dark:text-purple-300 sticky top-0">
                {t('settings.tts.multilingualVoices')}
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-700">
                {multilingualVoices.map((voice) => (
                  <VoiceRow
                    key={voice.name}
                    voice={voice}
                    isSelected={selectedVoice === voice.name}
                    isPreviewing={previewingVoice === voice.name}
                    regionCode=""
                    onSelect={() => onSelectVoice(voice.name)}
                    onPreview={() => handlePreviewVoice(voice)}
                  />
                ))}
              </div>
            </>
          )}

          {/* Language-Specific Voices Section */}
          {languageVoices.length > 0 && (
            <>
              <div className="px-3 py-1.5 bg-gray-50 dark:bg-gray-800 text-xs font-medium text-gray-600 dark:text-gray-400 sticky top-0 border-t border-gray-200 dark:border-gray-700">
                {selectedLanguageInfo?.displayName || selectedLanguage}{' '}
                {t('settings.tts.voices')}
              </div>
              <div className="divide-y divide-gray-100 dark:divide-gray-700">
                {languageVoices.map((voice) => (
                  <VoiceRow
                    key={voice.name}
                    voice={voice}
                    isSelected={selectedVoice === voice.name}
                    isPreviewing={previewingVoice === voice.name}
                    regionCode={getRegionCode(voice.locale)}
                    onSelect={() => onSelectVoice(voice.name)}
                    onPreview={() => handlePreviewVoice(voice)}
                  />
                ))}
              </div>
            </>
          )}

          {/* Empty State */}
          {multilingualVoices.length === 0 && languageVoices.length === 0 && (
            <div className="p-3 text-sm text-gray-500 dark:text-gray-400 text-center">
              {t('settings.tts.noVoicesAvailable')}
            </div>
          )}
        </div>

        {/* Selected Voice Info */}
        {selectedVoice && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
            {t('settings.tts.selectedVoice')}: {selectedVoice}
          </p>
        )}
      </div>
    </div>
  );
};

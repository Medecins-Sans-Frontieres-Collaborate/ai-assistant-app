'use client';

import {
  IconCheck,
  IconGenderFemale,
  IconGenderMale,
  IconLoader2,
  IconPlayerPlay,
} from '@tabler/icons-react';
import { FC, useCallback } from 'react';

import { VoiceInfo } from '@/types/tts';

interface VoiceRowProps {
  /** Voice information */
  voice: VoiceInfo;
  /** Whether this voice is currently selected */
  isSelected: boolean;
  /** Whether this voice is currently being previewed */
  isPreviewing: boolean;
  /** Region code for display (e.g., "US", "UK") - empty for multilingual */
  regionCode: string;
  /** Callback when voice is selected */
  onSelect: () => void;
  /** Callback to preview this voice */
  onPreview: () => void;
}

/**
 * Individual voice row component for the voice browser.
 * Shows voice name, region, gender, and preview button.
 */
export const VoiceRow: FC<VoiceRowProps> = ({
  voice,
  isSelected,
  isPreviewing,
  regionCode,
  onSelect,
  onPreview,
}) => {
  // Handle preview click without propagating to row click
  const handlePreviewClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onPreview();
    },
    [onPreview],
  );

  // Gender icon
  const GenderIcon =
    voice.gender === 'Female' ? IconGenderFemale : IconGenderMale;
  const genderColor =
    voice.gender === 'Female' ? 'text-pink-500' : 'text-blue-500';

  // Voice type badge styling
  const getTypeBadgeClass = () => {
    switch (voice.type) {
      case 'Multilingual':
        return 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300';
      case 'DragonHD':
        return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
      case 'Turbo':
        return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
      default:
        return '';
    }
  };

  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
        isSelected
          ? 'bg-gray-100 dark:bg-gray-700'
          : 'hover:bg-gray-50 dark:hover:bg-gray-800/50'
      }`}
      aria-pressed={isSelected}
    >
      {/* Selection indicator */}
      <div className="w-5 h-5 flex items-center justify-center flex-shrink-0">
        {isSelected && <IconCheck size={16} className="text-green-500" />}
      </div>

      {/* Voice name */}
      <span className="flex-1 text-sm text-gray-900 dark:text-gray-100 truncate">
        {voice.displayName}
      </span>

      {/* Voice type badge (only for non-Neural types) */}
      {voice.type !== 'Neural' && (
        <span
          className={`text-xs px-1.5 py-0.5 rounded flex-shrink-0 ${getTypeBadgeClass()}`}
        >
          {voice.type}
        </span>
      )}

      {/* Region code */}
      <span className="w-8 text-center text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
        {regionCode || '-'}
      </span>

      {/* Gender icon */}
      <GenderIcon size={16} className={`${genderColor} flex-shrink-0`} />

      {/* Preview button */}
      <button
        onClick={handlePreviewClick}
        disabled={isPreviewing}
        className="p-1.5 rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors disabled:opacity-50 flex-shrink-0"
        aria-label={`Preview ${voice.displayName}`}
        title={`Preview ${voice.displayName}`}
      >
        {isPreviewing ? (
          <IconLoader2 size={16} className="animate-spin text-gray-500" />
        ) : (
          <IconPlayerPlay
            size={16}
            className="text-gray-600 dark:text-gray-300"
          />
        )}
      </button>
    </button>
  );
};

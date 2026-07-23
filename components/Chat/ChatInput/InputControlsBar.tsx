import React from 'react';

import { InterpreterMode } from '@/types/interpreterMode';
import { SearchMode } from '@/types/searchMode';
import { Tone } from '@/types/tone';

import ChatInputSubmitButton from '@/components/Chat/ChatInput/ChatInputSubmitButton';
import ChatInputVoiceCapture from '@/components/Chat/ChatInput/ChatInputVoiceCapture';
import ChatDropdown from '@/components/Chat/ChatInput/Dropdown';

import { useChatInputStore } from '@/client/stores/chatInputStore';

interface InputControlsBarProps {
  onCameraClick: () => void;
  showDisclaimer: boolean;
  tones: Tone[];
  isStreaming: boolean;
  handleStopConversation: () => void;
  preventSubmission: () => boolean;
  handleSend: () => void;
}

export const InputControlsBar: React.FC<InputControlsBarProps> = ({
  onCameraClick,
  showDisclaimer,
  tones,
  isStreaming,
  handleStopConversation,
  preventSubmission,
  handleSend,
}) => {
  const searchMode = useChatInputStore((state) => state.searchMode);
  const interpreterMode = useChatInputStore((state) => state.interpreterMode);
  const selectedToneId = useChatInputStore((state) => state.selectedToneId);
  const isMultiline = useChatInputStore((state) => state.isMultiline);
  // Keep in sync with ChatInput's hasBadgeRow: any forced-mode/tone badge
  // expands the composer, and the controls drop to the badge row with it.
  const hasBadgeRow =
    searchMode === SearchMode.ALWAYS ||
    interpreterMode === InterpreterMode.ALWAYS ||
    !!selectedToneId;
  return (
    <>
      {/* Left controls */}
      <div
        className={`absolute left-2 flex items-center gap-2 z-[10001] transition-all duration-200 ${
          hasBadgeRow || isMultiline
            ? 'bottom-2'
            : 'top-1/2 transform -translate-y-1/2'
        }`}
      >
        <ChatDropdown
          onCameraClick={onCameraClick}
          openDownward={!showDisclaimer}
          tones={tones}
          handleSend={handleSend}
        />
      </div>

      {/* Right controls */}
      <div
        className={`absolute right-2.5 flex items-center gap-2 z-[10001] transition-all duration-200 ${
          hasBadgeRow || isMultiline
            ? 'bottom-2'
            : 'top-1/2 transform -translate-y-1/2'
        }`}
      >
        <ChatInputVoiceCapture />
        <ChatInputSubmitButton
          isStreaming={isStreaming}
          handleStopConversation={handleStopConversation}
          preventSubmission={preventSubmission}
          handleSend={handleSend}
        />
      </div>
    </>
  );
};

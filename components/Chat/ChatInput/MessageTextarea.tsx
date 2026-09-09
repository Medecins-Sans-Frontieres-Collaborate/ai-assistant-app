import React, { KeyboardEvent, MutableRefObject } from 'react';

interface MessageTextareaProps {
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  value: string;
  placeholder: string;
  disabled: boolean;
  /**
   * Whether a badge row (forced search / forced code execution / tone) is
   * showing below the text. Reserves bottom padding so badges get their own
   * row instead of overlapping the text and controls.
   */
  hasBadgeRow: boolean;
  textareaScrollHeight: number;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onFocus: () => void;
  onBlur: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

/**
 * Textarea component for message input
 * Handles dynamic height, multiline support, and accessibility
 */
export const MessageTextarea: React.FC<MessageTextareaProps> = ({
  textareaRef,
  value,
  placeholder,
  disabled,
  hasBadgeRow,
  textareaScrollHeight,
  onChange,
  onKeyDown,
  onFocus,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
}) => {
  return (
    <textarea
      ref={textareaRef}
      className={`m-0 w-full resize-none border-0 bg-transparent p-0 pr-24 text-black dark:bg-transparent dark:text-white focus:outline-none focus:ring-0 focus:border-0 ${
        hasBadgeRow ? 'pt-3 pb-[88px] pl-3' : 'py-3.5 pl-10 md:py-3 md:pl-10'
      }`}
      style={{
        resize: 'none',
        bottom: `${textareaScrollHeight}px`,
        maxHeight: '400px',
        overflow: `${textareaScrollHeight > 400 ? 'auto' : 'hidden'}`,
      }}
      placeholder={placeholder}
      value={value}
      rows={1}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      disabled={disabled}
    />
  );
};

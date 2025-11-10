import {
  ChatInputSubmitTypes,
  FileFieldValue,
  FileMessageContent,
  ImageMessageContent,
  TextMessageContent,
} from '@/types/chat';

/**
 * Wraps a value in an array if it's not already an array
 */
const wrapInArray = <T>(value: T | T[]): T[] => {
  return Array.isArray(value) ? value : [value];
};

/**
 * Builds message content based on submit type and field values
 * Extracted from ChatInput to improve testability and reusability
 *
 * @param submitType - The type of message being submitted (TEXT, IMAGE, FILE, MULTI_FILE)
 * @param textFieldValue - The text content of the message
 * @param imageFieldValue - Image field value (single or array)
 * @param fileFieldValue - File field value (single or array)
 * @param artifactContext - Optional artifact context to prepend to message
 * @returns The constructed message content
 * @throws Error if submitType is invalid
 */
export const buildMessageContent = (
  submitType: ChatInputSubmitTypes,
  textFieldValue: string,
  imageFieldValue: FileFieldValue,
  fileFieldValue: FileFieldValue,
  artifactContext?: string | null,
):
  | string
  | TextMessageContent
  | (TextMessageContent | FileMessageContent)[]
  | (TextMessageContent | ImageMessageContent)[]
  | (TextMessageContent | FileMessageContent | ImageMessageContent)[] => {
  // Prepend artifact context if provided
  const enhancedTextValue = artifactContext
    ? `${artifactContext}\n\n${textFieldValue}`
    : textFieldValue;

  if (submitType === 'TEXT') {
    return enhancedTextValue;
  }

  if (submitType === 'IMAGE') {
    const imageContents = imageFieldValue
      ? [
          ...wrapInArray(imageFieldValue),
          ...(fileFieldValue ? wrapInArray(fileFieldValue) : []),
        ]
      : fileFieldValue
        ? [...wrapInArray(fileFieldValue)]
        : [];

    return [
      ...imageContents.filter(
        (item): item is ImageMessageContent => item !== null,
      ),
      { type: 'text', text: enhancedTextValue } as TextMessageContent,
    ] as (TextMessageContent | ImageMessageContent)[];
  }

  if (submitType === 'FILE' || submitType === 'MULTI_FILE') {
    // For multi-file, we may have both images and files
    const imageContents = imageFieldValue
      ? wrapInArray(imageFieldValue).filter(
          (item): item is ImageMessageContent => item !== null,
        )
      : [];

    const fileContents = fileFieldValue
      ? wrapInArray(fileFieldValue).filter(
          (item): item is FileMessageContent => item !== null,
        )
      : [];

    // Only include text content if text is not empty (for audio/video transcription without instructions)
    const textContent = enhancedTextValue.trim()
      ? [{ type: 'text', text: enhancedTextValue } as TextMessageContent]
      : [];

    return [...imageContents, ...fileContents, ...textContent] as (
      | TextMessageContent
      | FileMessageContent
      | ImageMessageContent
    )[];
  }

  throw new Error(`Invalid submit type for message: ${submitType}`);
};

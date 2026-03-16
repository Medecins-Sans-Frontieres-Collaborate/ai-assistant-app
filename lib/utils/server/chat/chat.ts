import { Session } from 'next-auth';

import { isFileConversation, isImageConversation } from '@/lib/utils/app/chat';
import { getBase64FromImageURL } from '@/lib/utils/app/image';
import { getBlobBase64String } from '@/lib/utils/server/blob/blob';
import {
  ContentType,
  MessageContentAnalyzer,
} from '@/lib/utils/shared/chat/messageContentAnalyzer';

import {
  FileMessageContent,
  ImageMessageContent,
  Message,
  TextMessageContent,
} from '@/types/chat';

import { Tiktoken } from '@dqbd/tiktoken/lite/init';

type ContentItem =
  | TextMessageContent
  | FileMessageContent
  | ImageMessageContent;

/**
 * Detects ALL content types present in a message.
 * Returns a Set to properly handle mixed content (e.g., file + image).
 *
 * Now uses MessageContentAnalyzer for centralized logic.
 */
export const getMessageContentTypes = (
  content:
    | string
    | TextMessageContent
    | (TextMessageContent | FileMessageContent)[]
    | (TextMessageContent | ImageMessageContent)[]
    | (TextMessageContent | FileMessageContent | ImageMessageContent)[],
): Set<ContentType> => {
  const analyzer = new MessageContentAnalyzer(content);
  return analyzer.getContentTypes();
};

/**
 * Get primary content type for a message (for backward compatibility)
 * For mixed content, returns priority: file > audio > image > text
 */
const getPrimaryContentType = (
  content:
    | string
    | TextMessageContent
    | (TextMessageContent | FileMessageContent)[]
    | (TextMessageContent | ImageMessageContent)[]
    | (TextMessageContent | FileMessageContent | ImageMessageContent)[],
): ContentType => {
  const types = getMessageContentTypes(content);

  // Priority: file > audio > image > text
  if (types.has('file')) return 'file';
  if (types.has('audio')) return 'audio';
  if (types.has('image')) return 'image';
  if (types.has('text')) return 'text';

  throw new Error('Invalid content type or structure');
};

export const getMessagesToSend = async (
  messages: Message[],
  encoding: Tiktoken,
  promptLength: number,
  tokenLimit: number,
  user: Session['user'],
  // Optional active files (not used here; injection handled earlier in pipeline)
  _activeFiles?: import('@/types/chat').ActiveFile[],
): Promise<Message[]> => {
  const conversationType: ContentType = getPrimaryContentType(
    messages[messages.length - 1].content,
  );
  const fileConversation: boolean = isFileConversation(messages);
  let acc = { tokenCount: promptLength, messagesToSend: [] as Message[] };

  for (let i = messages.length - 1; i >= 0; i--) {
    let message = messages[i];
    delete message.messageType;
    const isLastMessage: boolean = messages.length - 1 === i;

    // Inject artifact context for user messages
    if (message.role === 'user' && message.artifactContext) {
      console.log('[Chat Utils] Processing artifact context:', {
        fileName: message.artifactContext.fileName,
        language: message.artifactContext.language,
        codeLength: message.artifactContext.code.length,
      });

      const artifactPrefix = `Currently editing: ${message.artifactContext.fileName} (${message.artifactContext.language})\n\`\`\`${message.artifactContext.language}\n${message.artifactContext.code}\n\`\`\`\n\n`;

      if (typeof message.content === 'string') {
        message.content = artifactPrefix + message.content;
      } else if (Array.isArray(message.content)) {
        // Find text content and prepend
        const textIndex = message.content.findIndex((c) => c.type === 'text');
        if (textIndex !== -1) {
          const textContent = message.content[textIndex] as TextMessageContent;
          message.content[textIndex] = {
            ...textContent,
            text: artifactPrefix + textContent.text,
          };
        }
      }

      // Remove artifactContext after processing to avoid sending to AI
      delete message.artifactContext;
    }

    if (Array.isArray(message.content)) {
      message.content = await processMessageContent(
        message.content,
        conversationType,
        isLastMessage,
        user,
      );
    } else if (typeof message.content === 'string') {
      /* pass */
    } else if (
      (
        message.content as
          | TextMessageContent
          | FileMessageContent
          | ImageMessageContent
      )?.type !== 'text'
    ) {
      throw new Error(`Unsupported message type: ${JSON.stringify(message)}`);
    }

    if (
      !isLastMessage &&
      conversationType !== 'image' &&
      Array.isArray(message.content)
    ) {
      message.content = extractTextContent(message.content);
    }
    acc.messagesToSend = [message, ...acc.messagesToSend];
  }

  return acc.messagesToSend;
};

const processMessageContent = async (
  content:
    | (TextMessageContent | FileMessageContent)[]
    | (TextMessageContent | ImageMessageContent)[]
    | (TextMessageContent | FileMessageContent | ImageMessageContent)[],
  conversationType: ContentType,
  isLastMessageInConversation: boolean,
  user: Session['user'],
): Promise<
  | (TextMessageContent | FileMessageContent)[]
  | (TextMessageContent | ImageMessageContent)[]
  | (TextMessageContent | FileMessageContent | ImageMessageContent)[]
> => {
  let allText: string = '';

  let processedContent:
    | (TextMessageContent | FileMessageContent)[]
    | (TextMessageContent | ImageMessageContent)[]
    | (TextMessageContent | FileMessageContent | ImageMessageContent)[] = (
    content as ContentItem[]
  ).filter((contentSection) => {
    if (!isLastMessageInConversation && contentSection.type === 'file_url') {
      return false; // Remove file_url content sections for non-last messages
    }
    return true;
  });

  for (let contentSection of processedContent) {
    if (conversationType === 'image' && contentSection.type === 'text') {
      allText += contentSection.text;
    } else if (
      conversationType !== 'text' &&
      contentSection.type === 'text' &&
      !isLastMessageInConversation
    ) {
      const contentTypePrefix: string =
        getContentTypePrefix(conversationType) + contentSection.text;
      contentSection.text = contentTypePrefix;
      allText += contentTypePrefix;
    } else if (
      conversationType === 'image' &&
      contentSection?.type === 'image_url'
    ) {
      const imageUrl: string = await processImageUrl(
        contentSection as ImageMessageContent,
        user,
      );
      allText += imageUrl;
      contentSection.image_url.url = imageUrl;
    }
  }

  return processedContent.map((contentSection) =>
    contentSection.type === 'image_url' &&
    !(conversationType === 'image') &&
    !(conversationType === 'file') // Don't convert images to text for file conversations
      ? ({
          type: 'text',
          text: 'THE USER UPLOADED AN IMAGE',
        } as TextMessageContent)
      : contentSection,
  ) as
    | (TextMessageContent | FileMessageContent)[]
    | (TextMessageContent | ImageMessageContent)[];
};

const getContentTypePrefix = (contentType: ContentType): string => {
  if (contentType === 'image') return 'THE USER UPLOADED AN IMAGE\n\n';
  if (contentType === 'file') return 'THE USER UPLOADED A FILE\n\n';
  return '';
};

const processImageUrl = async (
  contentSection: ImageMessageContent,
  user: Session['user'],
): Promise<string> => {
  // If already a base64 data URL, no conversion needed
  if (contentSection.image_url.url.startsWith('data:')) {
    return contentSection.image_url.url;
  }

  const id: string | undefined = contentSection.image_url.url.split('/').pop();
  if (!id || id.trim().length === 0) {
    throw new Error(`Image ID ${id} is not valid`);
  }

  let url: string;
  try {
    url = await getBlobBase64String(
      user?.id ?? 'anonymous',
      contentSection.image_url.url.split('/')[
        contentSection.image_url.url.split('/').length - 1
      ],
      'images',
      user,
    );
    contentSection.image_url = {
      url,
      detail: 'auto',
    };
    return url;
  } catch (error: unknown) {
    url = await getBase64FromImageURL(contentSection.image_url.url);
    contentSection.image_url = {
      url,
      detail: 'auto',
    };
    return url;
  }
};

const extractTextContent = (
  content:
    | (TextMessageContent | FileMessageContent)[]
    | (TextMessageContent | ImageMessageContent)[]
    | (TextMessageContent | FileMessageContent | ImageMessageContent)[],
): string => {
  // Handle empty content arrays gracefully
  if (!Array.isArray(content) || content.length === 0) {
    console.warn(
      '[extractTextContent] Received empty or invalid content array, returning empty string',
    );
    return '';
  }

  const textContent: TextMessageContent | undefined = (
    content as ContentItem[]
  ).find((contentItem) => contentItem.type === 'text') as
    | TextMessageContent
    | undefined;

  if (!textContent) {
    console.warn(
      `[extractTextContent] No text content found in array with ${content.length} items:`,
      content.map((c) => c.type).join(', '),
    );
    return '';
  }

  return textContent.text ?? '';
};

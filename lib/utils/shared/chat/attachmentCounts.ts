import { Message } from '@/types/chat';

import { isAudioVideoFile } from '@/lib/constants/fileTypes';

/**
 * Counts the documents attached to one chat message, by the same rule the
 * composer applies before upload: every `file_url` attachment that is not
 * audio or video. Images travel as `image_url` and have their own cap.
 *
 * @param message - A chat message (string content counts as zero).
 * @returns Number of document attachments.
 *
 * @example
 * countDocumentAttachments({ role: 'user', content: [
 *   { type: 'file_url', url: '/api/file/a.pdf', originalFilename: 'a.pdf' },
 *   { type: 'file_url', url: '/api/file/b.mp3', originalFilename: 'b.mp3' },
 * ] }); // => 1
 */
export function countDocumentAttachments(
  message: Pick<Message, 'content'> | undefined,
): number {
  if (!message || !Array.isArray(message.content)) return 0;
  return message.content.filter(
    (part) =>
      part.type === 'file_url' &&
      !isAudioVideoFile(part.originalFilename || part.url),
  ).length;
}

/**
 * Title Service
 *
 * Client-side service for generating AI-powered conversation titles.
 */
import { flattenEntriesForAPI } from '@/lib/utils/shared/chat/messageVersioning';

import { ConversationEntry } from '@/types/chat';

export interface TitleGenerationResult {
  title: string;
  fullTitle: string;
}

/**
 * Generates an AI-powered title for a conversation.
 *
 * @param entries - The conversation entries (messages)
 * @param modelId - The model ID to use for generation context
 * @returns The generated title, or null if generation failed
 */
export async function generateConversationTitle(
  entries: ConversationEntry[],
  modelId: string,
): Promise<TitleGenerationResult | null> {
  try {
    // Convert conversation entries to flat messages for API
    const messages = flattenEntriesForAPI(entries);

    if (messages.length === 0) {
      return null;
    }

    const response = await fetch('/api/chat/title', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages,
        modelId,
      }),
    });

    if (!response.ok) {
      console.error(
        '[TitleService] Failed to generate title:',
        response.status,
      );
      return null;
    }

    const result = await response.json();
    return {
      title: result.title,
      fullTitle: result.fullTitle,
    };
  } catch (error) {
    console.error('[TitleService] Error generating title:', error);
    return null;
  }
}

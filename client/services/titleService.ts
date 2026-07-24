/**
 * Title Service
 *
 * Client-side service for generating AI-powered conversation titles.
 */
import { VALIDATION_LIMITS } from '@/lib/utils/app/const';
import { flattenEntriesForAPI } from '@/lib/utils/shared/chat/messageVersioning';
import { windowMessagesForAPI } from '@/lib/utils/shared/chat/messageWindowing';

import { ConversationEntry } from '@/types/chat';

export interface TitleGenerationResult {
  title: string;
  fullTitle: string;
}

/**
 * Generates an AI-powered title for a conversation. The server always titles
 * with a fixed cheap model, so the conversation's own model is not sent.
 *
 * @param entries - The conversation entries (messages)
 * @returns The generated title, or null if generation failed
 */
export async function generateConversationTitle(
  entries: ConversationEntry[],
): Promise<TitleGenerationResult | null> {
  try {
    // Convert conversation entries to flat messages for API (title only needs a
    // few messages, so window to avoid sending the whole conversation history)
    const messages = windowMessagesForAPI(
      flattenEntriesForAPI(entries),
      VALIDATION_LIMITS.TITLE_MAX_MESSAGES,
    );

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
    // The server returns a null title when generation failed (best-effort
    // endpoint). Report that as a failed generation so callers keep their
    // local fallback name.
    if (!result?.title) {
      return null;
    }
    return {
      title: result.title,
      fullTitle: result.fullTitle,
    };
  } catch (error) {
    console.error('[TitleService] Error generating title:', error);
    return null;
  }
}

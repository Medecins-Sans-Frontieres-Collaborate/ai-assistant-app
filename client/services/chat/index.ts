/**
 * Frontend chat service.
 *
 * Unified chat service that routes ALL requests to /api/chat.
 * The server-side pipeline handles all routing and feature composition.
 *
 * Usage:
 * ```ts
 * import { chatService } from '@/client/services/chat';
 *
 * const stream = await chatService.chat(model, messages, {
 *   botId: 'my-bot',           // Enable RAG
 *   searchMode: 'intelligent',  // Enable search
 *   temperature: 0.7,
 * });
 * ```
 */

export { ChatService, chatService } from './ChatService';

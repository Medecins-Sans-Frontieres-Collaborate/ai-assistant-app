import { flattenEntriesForAPI } from '@/lib/utils/shared/chat/messageVersioning';
import { downloadFile } from '@/lib/utils/shared/document/exportUtils';

import { Conversation } from '@/types/chat';

import { useSettingsStore } from '@/client/stores/settingsStore';
import packageJson from '@/package.json';

/**
 * Debug bundle for the repeated-failure escalation banner: a JSON file the
 * user can download and attach to a support ticket when a conversation
 * keeps failing the same way.
 *
 * Privacy contract:
 * - `variant: 'metadata'` (the default) contains structure only — roles,
 *   content kinds/lengths, model id, error streak, app/build/region — and
 *   NEVER message text, the conversation name, or attachment filenames.
 * - `variant: 'full'` (explicit user opt-in via the "Include message text"
 *   checkbox) adds raw message content, the conversation name, and
 *   attachment filenames.
 * - NEITHER variant ever includes secrets: no tokens, no MCP server
 *   config (same deliberate exclusion as the settings export in
 *   importExport.ts), no system prompt, no env beyond version/build/env.
 */

export interface FailureStreakInfo {
  message: string;
  errorCode: string | null;
  count: number;
}

interface ChatDebugBundleParams {
  conversation: Conversation;
  streak: FailureStreakInfo | null;
  /** true = 'full' variant (message text + filenames + conversation name). */
  includeContent: boolean;
  app: { version: string; build: string; env: string };
  userRegion: string | null;
  modelListSource: string | null;
}

/** Pure builder — all inputs are parameters so it is trivially testable. */
export function buildChatDebugBundle(params: ChatDebugBundleParams): string {
  const {
    conversation,
    streak,
    includeContent,
    app,
    userRegion,
    modelListSource,
  } = params;

  const flat = flattenEntriesForAPI(conversation.messages);

  const messages = flat.map((message, index) => {
    const { content } = message;
    let contentKind: 'string' | 'parts' | 'object';
    let partTypes: string[] | undefined;
    let contentLength: number;
    if (typeof content === 'string') {
      contentKind = 'string';
      contentLength = content.length;
    } else if (Array.isArray(content)) {
      contentKind = 'parts';
      partTypes = content.map((part) => part.type);
      contentLength = content.reduce(
        (sum, part) => sum + ('text' in part ? part.text.length : 0),
        0,
      );
    } else {
      contentKind = 'object';
      partTypes = content ? [content.type] : undefined;
      contentLength = JSON.stringify(content ?? null).length;
    }
    return {
      index,
      role: message.role,
      contentKind,
      ...(partTypes ? { partTypes } : {}),
      contentLength,
      messageType: message.messageType ?? null,
      error: message.error === true,
      toolCallCount: message.toolCalls?.length ?? 0,
      ...(includeContent ? { content } : {}),
    };
  });

  const activeFiles = (conversation.activeFiles ?? []).map((file) => ({
    status: file.status,
    pinned: file.pinned === true,
    sizeBytes: file.sizeBytes ?? null,
    mimeType: file.mimeType ?? null,
    tokenEstimate: file.processedContent?.tokenEstimate ?? null,
    hasProcessedContent: !!file.processedContent,
    errorMessage: file.errorMessage ?? null,
    ...(includeContent ? { originalFilename: file.originalFilename } : {}),
  }));

  const bundle = {
    kind: 'chat-debug-bundle',
    variant: includeContent ? 'full' : 'metadata',
    generatedAt: new Date().toISOString(),
    app,
    region: {
      userRegion,
      hostedRegion: conversation.hostedRegion ?? null,
    },
    modelListSource,
    failureStreak: streak,
    conversation: {
      id: conversation.id,
      ...(includeContent ? { name: conversation.name } : {}),
      modelId: conversation.model?.id ?? null,
      temperature: conversation.temperature,
      defaultSearchMode: conversation.defaultSearchMode ?? null,
      threadId: conversation.threadId ?? null,
      messageCount: flat.length,
    },
    messages,
    activeFiles,
  };

  return JSON.stringify(bundle, null, 2);
}

/**
 * Assembles the bundle from live client state and triggers the browser
 * download. `NEXT_PUBLIC_*` must stay literal references (Next.js inlines
 * them at build time).
 */
export function downloadChatDebugBundle(
  conversation: Conversation,
  streak: FailureStreakInfo | null,
  includeContent: boolean,
): void {
  const { userRegion, modelListSource } = useSettingsStore.getState();
  const json = buildChatDebugBundle({
    conversation,
    streak,
    includeContent,
    app: {
      version: packageJson.version,
      build: process.env.NEXT_PUBLIC_BUILD || 'unknown',
      env: process.env.NEXT_PUBLIC_ENV || 'development',
    },
    userRegion: userRegion ?? null,
    modelListSource: modelListSource ?? null,
  });
  downloadFile(
    json,
    `chat-debug-${conversation.id.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.json`,
    'application/json',
  );
}

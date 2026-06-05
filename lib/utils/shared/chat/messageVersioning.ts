import {
  AssistantMessageGroup,
  AssistantMessageVersion,
  ConversationEntry,
  Message,
  MessageType,
  VersionInfo,
  isAssistantMessageGroup,
  isLegacyMessage,
} from '@/types/chat';

/**
 * Converts a ConversationEntry to a displayable Message.
 * For AssistantMessageGroup, returns the active version as a Message.
 * For legacy Messages, returns them unchanged.
 *
 * @param entry - The conversation entry (Message or AssistantMessageGroup)
 * @returns A Message suitable for display
 */
export function entryToDisplayMessage(entry: ConversationEntry): Message {
  if (isAssistantMessageGroup(entry)) {
    const activeVersion = entry.versions[entry.activeIndex];
    return {
      role: 'assistant',
      content: activeVersion.content,
      messageType: activeVersion.messageType,
      citations: activeVersion.citations,
      thinking: activeVersion.thinking,
      transcript: activeVersion.transcript,
      error: activeVersion.error,
      approvalOutcomes: activeVersion.approvalOutcomes,
      approvalSources: activeVersion.approvalSources,
      toolCalls: activeVersion.toolCalls,
    };
  }
  return entry;
}

/**
 * Converts a Message to an AssistantMessageVersion.
 * Used when creating new versions from assistant responses.
 *
 * @param message - The message to convert
 * @returns An AssistantMessageVersion with a createdAt timestamp
 */
export function messageToVersion(message: Message): AssistantMessageVersion {
  return {
    content: message.content,
    messageType: message.messageType,
    citations: message.citations,
    thinking: message.thinking,
    transcript: message.transcript,
    error: message.error,
    approvalOutcomes: message.approvalOutcomes,
    approvalSources: message.approvalSources,
    toolCalls: message.toolCalls,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Flattens conversation entries to a messages array for API calls.
 * Extracts only active versions from groups and all user messages.
 * The API expects a flat Message[] array.
 *
 * @param entries - The conversation entries (mixed Messages and AssistantMessageGroups)
 * @returns A flat Message[] array suitable for API requests
 */
export function flattenEntriesForAPI(entries: ConversationEntry[]): Message[] {
  return entries.map((entry) => entryToDisplayMessage(entry));
}

/**
 * Gets version info for a message entry at a given index.
 * Returns null for user messages or legacy assistant messages without versioning.
 * Returns version info for AssistantMessageGroups.
 *
 * @param entry - The conversation entry to get version info for
 * @returns VersionInfo if the entry has versions, null otherwise
 */
export function getVersionInfo(entry: ConversationEntry): VersionInfo | null {
  if (!isAssistantMessageGroup(entry)) {
    return null;
  }
  return {
    current: entry.activeIndex + 1, // 1-indexed for display
    total: entry.versions.length,
    hasMultiple: entry.versions.length > 1,
  };
}

/**
 * Creates a new AssistantMessageGroup from a message.
 * Used when adding the first assistant response (creates a group with one version).
 *
 * @param message - The assistant message to wrap in a group
 * @returns An AssistantMessageGroup containing one version
 */
export function createMessageGroup(message: Message): AssistantMessageGroup {
  return {
    type: 'assistant_group',
    activeIndex: 0,
    versions: [messageToVersion(message)],
  };
}

/**
 * Adds a new version to an existing AssistantMessageGroup.
 * The new version becomes the active version.
 *
 * @param group - The existing message group
 * @param message - The new message to add as a version
 * @returns A new AssistantMessageGroup with the new version added and active
 */
export function addVersionToGroup(
  group: AssistantMessageGroup,
  message: Message,
): AssistantMessageGroup {
  const newVersion = messageToVersion(message);
  return {
    ...group,
    versions: [...group.versions, newVersion],
    activeIndex: group.versions.length, // Point to the new version
  };
}

/**
 * Converts legacy Message[] to ConversationEntry[] for migration.
 * Legacy assistant messages become single-version groups.
 * User and system messages remain unchanged.
 *
 * @param messages - The legacy messages array
 * @returns ConversationEntry[] with assistant messages wrapped in groups
 */
export function migrateLegacyMessages(
  messages: Message[],
): ConversationEntry[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return createMessageGroup(message);
    }
    return message;
  });
}

/**
 * Checks if a conversation needs migration (has legacy flat assistant messages).
 * A conversation needs migration if any assistant message is not wrapped in a group.
 *
 * @param entries - The conversation entries to check
 * @returns true if any assistant message is a legacy Message, false otherwise
 */
export function needsMigration(entries: ConversationEntry[]): boolean {
  return entries.some(
    (entry) => isLegacyMessage(entry) && entry.role === 'assistant',
  );
}

/**
 * Finds the index of the user message that precedes an assistant message group.
 * Used when regenerating to know which user message to resend.
 *
 * @param entries - The conversation entries
 * @param assistantIndex - The index of the assistant message/group
 * @returns The index of the preceding user message, or -1 if not found
 */
export function findPrecedingUserMessageIndex(
  entries: ConversationEntry[],
  assistantIndex: number,
): number {
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isLegacyMessage(entry) && entry.role === 'user') {
      return i;
    }
  }
  return -1;
}

/**
 * Gets the messages up to and including a specific user message index.
 * Used to prepare the conversation context for regeneration.
 *
 * @param entries - The conversation entries
 * @param userMessageIndex - The index of the user message to include
 * @returns Flattened Message[] up to the user message
 */
export function getMessagesUpToUser(
  entries: ConversationEntry[],
  userMessageIndex: number,
): Message[] {
  return flattenEntriesForAPI(entries.slice(0, userMessageIndex + 1));
}

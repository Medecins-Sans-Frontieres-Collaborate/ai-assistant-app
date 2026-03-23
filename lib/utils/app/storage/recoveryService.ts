/**
 * Recovery Service
 *
 * Attempts progressive repair of corrupted conversation data.
 * Three levels of repair:
 * 1. JSON repair — fix common JSON issues (trailing commas, truncation)
 * 2. Field repair — fill missing required fields with defaults
 * 3. Message salvage — keep valid messages, discard corrupt ones
 */
import {
  Conversation,
  ConversationEntry,
  isAssistantMessageGroup,
} from '@/types/chat';
import { OpenAIModelID, OpenAIModels } from '@/types/openai';
import { RecoveryResult, RecoveryStats } from '@/types/storage';

import { tryParseJSON, validateConversation } from './conversationValidator';

import { getDefaultModel } from '@/config/models';

/**
 * Attempt to repair broken JSON strings.
 * Handles trailing commas, truncated JSON (unclosed brackets/braces).
 */
function repairJSON(raw: string): string {
  let repaired = raw.trim();

  // Remove trailing commas before closing brackets/braces
  repaired = repaired.replace(/,\s*([\]}])/g, '$1');

  // Try to close unclosed structures for truncated JSON
  const openBraces = (repaired.match(/{/g) || []).length;
  const closeBraces = (repaired.match(/}/g) || []).length;
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/]/g) || []).length;

  // Close unclosed arrays first, then objects
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    repaired += ']';
  }
  for (let i = 0; i < openBraces - closeBraces; i++) {
    repaired += '}';
  }

  return repaired;
}

/**
 * Get a fallback OpenAIModel for recovery purposes.
 */
function getRecoveryModel() {
  const defaultModelId = getDefaultModel();
  const model = OpenAIModels[defaultModelId as OpenAIModelID];
  if (model) return model;

  // Fallback to first available model
  const models = Object.values(OpenAIModels);
  return models[0];
}

/**
 * Validate a single message entry (Message or AssistantMessageGroup).
 * Returns true if the entry is structurally valid enough to keep.
 */
function isValidMessageEntry(entry: unknown): entry is ConversationEntry {
  if (!entry || typeof entry !== 'object') return false;

  const obj = entry as Record<string, unknown>;

  // Check if it's an AssistantMessageGroup
  if (obj.type === 'assistant_group') {
    return (
      Array.isArray(obj.versions) &&
      obj.versions.length > 0 &&
      typeof obj.activeIndex === 'number'
    );
  }

  // Check if it's a Message — must have role and content
  if (typeof obj.role === 'string' && obj.content !== undefined) {
    return true;
  }

  return false;
}

/**
 * Attempt to recover a conversation from raw data.
 * Applies progressive repair levels.
 */
export function attemptRecovery(rawData: string): RecoveryResult {
  const stats: RecoveryStats = {
    messagesRecovered: 0,
    messagesLost: 0,
    fieldsRepaired: [],
  };

  // Level 1: Try parsing as-is
  let parsed = tryParseJSON<Record<string, unknown>>(rawData);

  // Level 1b: If parse fails, try JSON repair
  if (!parsed.data) {
    const repaired = repairJSON(rawData);
    parsed = tryParseJSON<Record<string, unknown>>(repaired);

    if (!parsed.data) {
      return { recovered: false, stats };
    }
    stats.fieldsRepaired.push('json_structure');
  }

  const obj = parsed.data;

  // Level 2: Field repair — fill missing required fields
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    obj.id = globalThis.crypto.randomUUID();
    stats.fieldsRepaired.push('id');
  }

  if (typeof obj.name !== 'string') {
    obj.name = 'Recovered Conversation';
    stats.fieldsRepaired.push('name');
  }

  if (!Array.isArray(obj.messages)) {
    obj.messages = [];
    stats.fieldsRepaired.push('messages');
  }

  if (
    !obj.model ||
    typeof obj.model !== 'object' ||
    typeof (obj.model as Record<string, unknown>).id !== 'string'
  ) {
    obj.model = getRecoveryModel();
    stats.fieldsRepaired.push('model');
  }

  if (typeof obj.temperature !== 'number') {
    obj.temperature = 0.7;
    stats.fieldsRepaired.push('temperature');
  }

  if (typeof obj.prompt !== 'string') {
    obj.prompt = '';
    stats.fieldsRepaired.push('prompt');
  }

  if (obj.folderId !== null && typeof obj.folderId !== 'string') {
    obj.folderId = null;
    stats.fieldsRepaired.push('folderId');
  }

  // Level 3: Message salvage — keep valid messages, discard corrupt ones
  if (Array.isArray(obj.messages)) {
    const originalCount = obj.messages.length;
    const validMessages: ConversationEntry[] = [];

    for (const entry of obj.messages) {
      if (isValidMessageEntry(entry)) {
        validMessages.push(entry as ConversationEntry);
      }
    }

    stats.messagesRecovered = validMessages.length;
    stats.messagesLost = originalCount - validMessages.length;
    obj.messages = validMessages;

    if (stats.messagesLost > 0) {
      stats.fieldsRepaired.push('messages_filtered');
    }
  }

  // Add recovery metadata
  if (!obj.updatedAt) {
    obj.updatedAt = new Date().toISOString();
  }
  if (!obj.createdAt) {
    obj.createdAt = obj.updatedAt;
  }

  // Final validation
  const validation = validateConversation(obj);
  if (!validation.valid) {
    return { recovered: false, stats };
  }

  // Mark the name if it was a recovered conversation
  if (
    stats.fieldsRepaired.length > 0 &&
    !stats.fieldsRepaired.includes('name')
  ) {
    // Prefix existing name to indicate recovery
    const conv = validation.data!;
    if (!conv.name.startsWith('[Recovered]')) {
      (obj as Record<string, unknown>).name = `[Recovered] ${conv.name}`;
    }
  }

  return {
    recovered: true,
    conversation: obj as unknown as Conversation,
    stats,
  };
}

import { Conversation } from '@/types/chat';

/**
 * Format for single conversation export
 */
export interface ConversationExportFormat {
  version: 1;
  type: 'single-conversation';
  conversation: Conversation;
  exportedAt: string;
}

/**
 * Validate if imported data is a valid conversation export
 */
export function isValidConversationExport(
  data: any,
): data is ConversationExportFormat {
  return (
    data &&
    typeof data === 'object' &&
    data.version === 1 &&
    data.type === 'single-conversation' &&
    data.conversation &&
    typeof data.conversation === 'object' &&
    typeof data.conversation.id === 'string' &&
    typeof data.conversation.name === 'string' &&
    Array.isArray(data.conversation.messages)
  );
}

/**
 * Generate a safe filename from conversation name
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-z0-9]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
    .substring(0, 50);
}

/**
 * Get current date string for filename
 */
function getCurrentDateString(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Export a single conversation as a JSON file
 */
export function exportConversation(conversation: Conversation): void {
  const exportData: ConversationExportFormat = {
    version: 1,
    type: 'single-conversation',
    conversation,
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: 'application/json',
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  const safeName = sanitizeFilename(conversation.name);
  const dateString = getCurrentDateString();
  link.download = `conversation_${safeName}_${dateString}.json`;

  link.href = url;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Validate and prepare imported conversation data
 * Regenerates ID if it already exists in the provided conversation list
 */
export function validateAndPrepareImport(
  data: any,
  existingConversations: Conversation[],
): {
  isValid: boolean;
  conversation?: Conversation;
  error?: string;
} {
  // Validate format
  if (!isValidConversationExport(data)) {
    return {
      isValid: false,
      error:
        'Invalid conversation file format. Please select a valid conversation export file.',
    };
  }

  const conversation = data.conversation;

  // Check for ID conflicts
  const idExists = existingConversations.some((c) => c.id === conversation.id);

  if (idExists) {
    // Regenerate ID to avoid conflicts
    const newId = `conversation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const updatedConversation: Conversation = {
      ...conversation,
      id: newId,
      name: `${conversation.name} (imported)`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return {
      isValid: true,
      conversation: updatedConversation,
    };
  }

  // Add timestamps if missing
  const updatedConversation: Conversation = {
    ...conversation,
    createdAt: conversation.createdAt || new Date().toISOString(),
    updatedAt: conversation.updatedAt || new Date().toISOString(),
  };

  return {
    isValid: true,
    conversation: updatedConversation,
  };
}

/**
 * Read and parse a conversation file
 */
export async function readConversationFile(
  file: File,
): Promise<ConversationExportFormat> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        resolve(data);
      } catch (error) {
        reject(new Error('Failed to parse conversation file'));
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read conversation file'));
    };

    reader.readAsText(file);
  });
}

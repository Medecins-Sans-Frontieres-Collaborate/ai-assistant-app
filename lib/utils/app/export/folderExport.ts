import { Conversation } from '@/types/chat';
import { FolderInterface } from '@/types/folder';

/**
 * Format for folder export (includes folder and all its conversations)
 */
export interface FolderExportFormat {
  version: 1;
  type: 'folder-with-conversations';
  folder: FolderInterface;
  conversations: Conversation[];
  exportedAt: string;
}

/**
 * Validate if imported data is a valid folder export
 */
export function isValidFolderExport(data: any): data is FolderExportFormat {
  return (
    data &&
    typeof data === 'object' &&
    data.version === 1 &&
    data.type === 'folder-with-conversations' &&
    data.folder &&
    typeof data.folder === 'object' &&
    typeof data.folder.id === 'string' &&
    typeof data.folder.name === 'string' &&
    Array.isArray(data.conversations)
  );
}

/**
 * Generate a safe filename from folder name
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
 * Export a folder with all its conversations as a JSON file
 */
export function exportFolder(
  folder: FolderInterface,
  conversations: Conversation[],
): void {
  // Filter conversations that belong to this folder
  const folderConversations = conversations.filter(
    (conv) => conv.folderId === folder.id,
  );

  const exportData: FolderExportFormat = {
    version: 1,
    type: 'folder-with-conversations',
    folder,
    conversations: folderConversations,
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: 'application/json',
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  const safeName = sanitizeFilename(folder.name);
  const dateString = getCurrentDateString();
  const conversationCount = folderConversations.length;
  link.download = `folder_${safeName}_${conversationCount}chats_${dateString}.json`;

  link.href = url;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Validate and prepare imported folder data
 * Regenerates IDs if they already exist
 */
export function validateAndPrepareFolderImport(
  data: any,
  existingFolders: FolderInterface[],
  existingConversations: Conversation[],
): {
  isValid: boolean;
  folder?: FolderInterface;
  conversations?: Conversation[];
  error?: string;
} {
  // Validate format
  if (!isValidFolderExport(data)) {
    return {
      isValid: false,
      error:
        'Invalid folder file format. Please select a valid folder export file.',
    };
  }

  const folder = data.folder;
  const conversations = data.conversations;

  // Check for folder ID conflicts
  const folderIdExists = existingFolders.some((f) => f.id === folder.id);
  const newFolderId = folderIdExists
    ? `folder-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
    : folder.id;

  // Create the new folder
  const updatedFolder: FolderInterface = {
    ...folder,
    id: newFolderId,
    name: folderIdExists ? `${folder.name} (imported)` : folder.name,
  };

  // Update all conversations to reference the new folder ID
  const updatedConversations: Conversation[] = conversations.map((conv) => {
    // Check if conversation ID exists
    const convIdExists = existingConversations.some((c) => c.id === conv.id);
    const newConvId = convIdExists
      ? `conversation-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
      : conv.id;

    return {
      ...conv,
      id: newConvId,
      folderId: newFolderId, // Update to reference the new folder
      name: convIdExists ? `${conv.name} (imported)` : conv.name,
      createdAt: conv.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  });

  return {
    isValid: true,
    folder: updatedFolder,
    conversations: updatedConversations,
  };
}

/**
 * Read and parse a folder file
 */
export async function readFolderFile(file: File): Promise<FolderExportFormat> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        resolve(data);
      } catch (error) {
        reject(new Error('Failed to parse folder file'));
      }
    };

    reader.onerror = () => {
      reject(new Error('Failed to read folder file'));
    };

    reader.readAsText(file);
  });
}

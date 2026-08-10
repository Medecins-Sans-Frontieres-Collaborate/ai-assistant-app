import type { SyncCrypto } from '@/lib/services/backup/types';

import type { Conversation } from '@/types/chat';
import type { FolderInterface } from '@/types/folder';

/**
 * Plaintext "crypto" for the unencrypted OneDrive backup mode: blobs are
 * UTF-8 JSON, readable directly in the user's OneDrive. Allowed ONLY for
 * the onedrive backend — the user owns that storage; app storage must never
 * hold readable chat content. The mode is an explicit, warned opt-in.
 *
 * The manifest's keyId slot carries a sentinel so other devices can tell a
 * plain backup from an encrypted one (16 hex chars — passes the server's
 * KEY_ID_REGEX; a real HKDF fingerprint colliding with it is negligible).
 */
export const PLAIN_BACKUP_KEY_ID = '0000000000000000';

export function isPlainBackupKeyId(keyId: string | null | undefined): boolean {
  return keyId === PLAIN_BACKUP_KEY_ID;
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decode<T>(bytes: Uint8Array, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new Error(`Plain backup blob is not valid JSON (${what})`);
  }
}

/** SyncCrypto implementation for the plain mode — same engine, no keys. */
export function createPlainSyncCrypto(epoch: number): SyncCrypto {
  return {
    keyId: PLAIN_BACKUP_KEY_ID,
    epoch,
    encryptConversation: async (conversation) => encode(conversation),
    decryptConversation: async (conversationId, _epoch, ciphertext) => {
      const conversation = decode<Conversation>(
        ciphertext,
        `conversation ${conversationId}`,
      );
      // The AEAD path binds blob↔id via AAD; the plain path at least
      // refuses a blob that plainly belongs to a different conversation.
      if (conversation?.id !== conversationId) {
        throw new Error(
          `Plain backup blob id mismatch for conversation ${conversationId}`,
        );
      }
      return conversation;
    },
    encryptFolders: async (folders) => encode(folders),
    decryptFolders: async (_epoch, ciphertext) => {
      const folders = decode<FolderInterface[]>(ciphertext, 'folders');
      if (!Array.isArray(folders)) {
        throw new Error('Plain backup folders blob is not an array');
      }
      return folders;
    },
  };
}

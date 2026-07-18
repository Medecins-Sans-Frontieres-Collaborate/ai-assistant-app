'use client';

/**
 * Bridges the derived backup keys to the sync engine's SyncCrypto surface.
 * Each blob is a JSON-serialized CipherEnvelopeV1 (UTF-8 bytes on the wire);
 * the AAD slot id is the conversation id, or FOLDERS_SLOT_ID for the folders
 * blob. The epoch passed per call is the manifest epoch in effect for that
 * read/write (it feeds the AAD); `epoch` on the object is this device's
 * cached epoch, used by the engine only to seed a first-push manifest.
 */
import type { SyncCrypto } from '@/lib/services/backup/types';

import {
  type CipherEnvelopeV1,
  decryptEnvelope,
  encryptEnvelope,
} from '@/lib/utils/shared/backupCrypto/envelope';
import type { BackupKeys } from '@/lib/utils/shared/backupCrypto/keyDerivation';

import type { Conversation } from '@/types/chat';
import type { FolderInterface } from '@/types/folder';

/** AAD slot id binding the folders blob (never a valid conversation id). */
export const FOLDERS_SLOT_ID = 'folders';

export function createSyncCrypto(keys: BackupKeys, epoch: number): SyncCrypto {
  const encrypt = async (
    plaintext: string,
    slotEpoch: number,
    slotId: string,
  ): Promise<Uint8Array> => {
    const envelope = await encryptEnvelope({
      plaintext,
      encKey: keys.encKey,
      keyId: keys.keyId,
      epoch: slotEpoch,
      conversationId: slotId,
    });
    return new TextEncoder().encode(JSON.stringify(envelope));
  };

  const decrypt = async (
    ciphertext: Uint8Array,
    slotId: string,
  ): Promise<string> => {
    const envelope = JSON.parse(
      new TextDecoder().decode(ciphertext),
    ) as CipherEnvelopeV1;
    return decryptEnvelope({
      envelope,
      encKey: keys.encKey,
      keyId: keys.keyId,
      conversationId: slotId,
    });
  };

  return {
    keyId: keys.keyId,
    epoch,
    encryptConversation: (conversation, slotEpoch) =>
      encrypt(JSON.stringify(conversation), slotEpoch, conversation.id),
    decryptConversation: async (conversationId, _slotEpoch, ciphertext) =>
      JSON.parse(await decrypt(ciphertext, conversationId)) as Conversation,
    encryptFolders: (folders, slotEpoch) =>
      encrypt(JSON.stringify(folders), slotEpoch, FOLDERS_SLOT_ID),
    decryptFolders: async (_slotEpoch, ciphertext) =>
      JSON.parse(
        await decrypt(ciphertext, FOLDERS_SLOT_ID),
      ) as FolderInterface[],
  };
}

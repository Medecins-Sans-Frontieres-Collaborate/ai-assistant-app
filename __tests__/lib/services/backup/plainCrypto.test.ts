import {
  PLAIN_BACKUP_KEY_ID,
  createPlainSyncCrypto,
  isPlainBackupKeyId,
} from '@/lib/services/backup/plainCrypto';

import type { Conversation } from '@/types/chat';
import type { FolderInterface } from '@/types/folder';

import { describe, expect, it } from 'vitest';

describe('plainCrypto', () => {
  const crypto = createPlainSyncCrypto(3);

  it('uses the sentinel key id (16 hex — passes server validation)', () => {
    expect(crypto.keyId).toBe(PLAIN_BACKUP_KEY_ID);
    expect(PLAIN_BACKUP_KEY_ID).toMatch(/^[0-9a-f]{16}$/);
    expect(isPlainBackupKeyId(PLAIN_BACKUP_KEY_ID)).toBe(true);
    expect(isPlainBackupKeyId('a1b2c3d4e5f60718')).toBe(false);
    expect(isPlainBackupKeyId(null)).toBe(false);
  });

  it('round-trips a conversation as readable JSON', async () => {
    const conversation = {
      id: 'c1',
      name: 'Test — émojis 🚀',
      updatedAt: '2026-08-01T00:00:00.000Z',
    } as Conversation;

    const bytes = await crypto.encryptConversation(conversation, 3);
    // The whole point of plain mode: the blob is readable as-is.
    expect(new TextDecoder().decode(bytes)).toContain('Test — émojis 🚀');

    const restored = await crypto.decryptConversation('c1', 3, bytes);
    expect(restored).toEqual(conversation);
  });

  it('rejects a blob whose embedded id does not match the requested one', async () => {
    const bytes = await crypto.encryptConversation(
      { id: 'c1' } as Conversation,
      3,
    );
    await expect(crypto.decryptConversation('c2', 3, bytes)).rejects.toThrow(
      /id mismatch/,
    );
  });

  it('rejects non-JSON bytes with a clear error', async () => {
    const garbage = new TextEncoder().encode('not json at all {');
    await expect(crypto.decryptConversation('c1', 3, garbage)).rejects.toThrow(
      /not valid JSON/,
    );
    await expect(crypto.decryptFolders(3, garbage)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('round-trips folders and rejects a non-array folders blob', async () => {
    const folders = [
      { id: 'f1', name: 'Work', type: 'chat' },
    ] as FolderInterface[];
    const bytes = await crypto.encryptFolders(folders, 3);
    expect(await crypto.decryptFolders(3, bytes)).toEqual(folders);

    const notArray = new TextEncoder().encode('{"id":"f1"}');
    await expect(crypto.decryptFolders(3, notArray)).rejects.toThrow(
      /not an array/,
    );
  });
});

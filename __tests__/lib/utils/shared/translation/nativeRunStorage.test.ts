import {
  RUN_EXPIRY_WARNING_DAYS,
  RUN_RECORD_ID,
  RUN_RETENTION_DAYS,
  RunFileIntegrityError,
  base64ToBytes,
  bytesToBase64,
  decryptRunFile,
  deriveRunKey,
  encryptRunFile,
  isEncryptedRunFile,
  isRunFileId,
  isRunId,
  parseRunFileUrl,
  runDaysLeft,
  runExpiry,
  runExpiryState,
  runFileUrl,
} from '@/lib/utils/shared/translation/nativeRunStorage';

import { describe, expect, it } from 'vitest';

const RUN = '11111111-2222-4333-8444-555555555555';
const OTHER_RUN = '99999999-2222-4333-8444-555555555555';
const FILE = `${'a'.repeat(64)}.pdf`;
const DAY = 24 * 60 * 60 * 1000;
const master = new Uint8Array(32).fill(7);
const text = (value: string) => new TextEncoder().encode(value);

describe('run and file names', () => {
  it('accepts only UUIDs as run ids', () => {
    expect(isRunId(RUN)).toBe(true);
    expect(isRunId('../other-user')).toBe(false);
    expect(isRunId('ABCDEF12-2222-4333-8444-555555555555')).toBe(false);
    expect(isRunId('abcdef12-2222-4333-8444-555555555555')).toBe(true);
    expect(isRunId(undefined)).toBe(false);
  });

  it('accepts hashed files and the record, nothing that could leave the folder', () => {
    expect(isRunFileId(FILE)).toBe(true);
    expect(isRunFileId(RUN_RECORD_ID)).toBe(true);
    expect(isRunFileId(`../${FILE}`)).toBe(false);
    expect(isRunFileId(`${'a'.repeat(64)}.exe`)).toBe(false);
    expect(isRunFileId('notes.json')).toBe(false);
  });

  it('reads back the paths it makes, and no others', () => {
    const url = runFileUrl({ runId: RUN, backend: 'onedrive' }, FILE);
    expect(parseRunFileUrl(url)).toEqual({
      runId: RUN,
      backend: 'onedrive',
      fileId: FILE,
    });
    expect(parseRunFileUrl('/api/file/abc.pdf')).toBeNull();
    expect(parseRunFileUrl(url.replace('onedrive', 'elsewhere'))).toBeNull();
  });
});

describe('expiry', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const inDays = (days: number) => new Date(now + days * DAY).toISOString();

  it('expires a run the retention period after its oldest write', () => {
    expect(runExpiry(new Date(now)).getTime()).toBe(
      now + RUN_RETENTION_DAYS * DAY,
    );
  });

  it('warns at the warning period and not a moment before', () => {
    expect(runExpiryState(inDays(RUN_EXPIRY_WARNING_DAYS), now)).toBe('soon');
    expect(
      runExpiryState(
        new Date(now + RUN_EXPIRY_WARNING_DAYS * DAY + 1000).toISOString(),
        now,
      ),
    ).toBe('fine');
    expect(runExpiryState(inDays(0.01), now)).toBe('soon');
    expect(runExpiryState(inDays(0), now)).toBe('expired');
    expect(runExpiryState(inDays(-1), now)).toBe('expired');
  });

  it('treats a run without an expiry as kept', () => {
    expect(runExpiryState(undefined, now)).toBe('kept');
    expect(runExpiryState('not a date', now)).toBe('kept');
  });

  it('counts the days left, rounded up', () => {
    expect(runDaysLeft(inDays(1.2), now)).toBe(2);
    expect(runDaysLeft(inDays(1), now)).toBe(1);
    expect(runDaysLeft(inDays(-3), now)).toBe(0);
  });
});

describe('encryption', () => {
  it('gives each run its own key, the same every time', async () => {
    const key = await deriveRunKey(master, RUN);
    expect(key).toHaveLength(32);
    expect(await deriveRunKey(master, RUN)).toEqual(key);
    expect(await deriveRunKey(master, OTHER_RUN)).not.toEqual(key);
    expect(await deriveRunKey(new Uint8Array(32).fill(8), RUN)).not.toEqual(
      key,
    );
    expect(key).not.toEqual(master);
  });

  it('round-trips a file and hides its content', async () => {
    const key = await deriveRunKey(master, RUN);
    const stored = await encryptRunFile(key, RUN, FILE, text('%PDF-secret'));
    expect(isEncryptedRunFile(stored)).toBe(true);
    expect(new TextDecoder().decode(stored)).not.toContain('secret');
    expect(await decryptRunFile(key, RUN, FILE, stored)).toEqual(
      text('%PDF-secret'),
    );
    // A fresh nonce each time: the same file never stores the same bytes.
    expect(
      await encryptRunFile(key, RUN, FILE, text('%PDF-secret')),
    ).not.toEqual(stored);
  });

  it('refuses another key, another run, another file name, and changed bytes', async () => {
    const key = await deriveRunKey(master, RUN);
    const stored = await encryptRunFile(key, RUN, FILE, text('content'));
    const otherKey = await deriveRunKey(master, OTHER_RUN);
    await expect(decryptRunFile(otherKey, RUN, FILE, stored)).rejects.toThrow(
      RunFileIntegrityError,
    );
    await expect(decryptRunFile(key, OTHER_RUN, FILE, stored)).rejects.toThrow(
      RunFileIntegrityError,
    );
    await expect(
      decryptRunFile(key, RUN, RUN_RECORD_ID, stored),
    ).rejects.toThrow(RunFileIntegrityError);
    const changed = new Uint8Array(stored);
    changed[changed.length - 1] ^= 1;
    await expect(decryptRunFile(key, RUN, FILE, changed)).rejects.toThrow(
      RunFileIntegrityError,
    );
  });

  it('does not mistake a plain file for an encrypted one', async () => {
    expect(isEncryptedRunFile(text('%PDF-1.7 plain'))).toBe(false);
    const key = await deriveRunKey(master, RUN);
    await expect(
      decryptRunFile(key, RUN, FILE, text('%PDF-1.7 plain')),
    ).rejects.toThrow(RunFileIntegrityError);
  });

  it('round-trips bytes through base64', () => {
    const bytes = Uint8Array.from({ length: 70000 }, (_, index) => index % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64ToBytes('not base64!')).toBeNull();
  });
});

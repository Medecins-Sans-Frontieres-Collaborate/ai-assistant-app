import {
  readOwnedRunMetadata,
  readRunFileIfExists,
  runFileExists,
} from '@/lib/services/grants/runFiles';

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The run routes learn "exists" from the read itself (no access() first —
 * CodeQL js/file-system-race) and treat every not-owned case as a uniform
 * "not found", so a shared run URL never confirms a foreign run's existence.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grant-run-files-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readRunFileIfExists / runFileExists', () => {
  it('returns null (and false) for a file that is not there yet', async () => {
    const path = join(dir, 'output.csv');
    expect(await readRunFileIfExists(path)).toBeNull();
    expect(await runFileExists(path)).toBe(false);
  });

  it('returns the content (and true) once it exists', async () => {
    const path = join(dir, 'output.csv');
    await writeFile(path, 'a,b\n1,2');
    expect(await readRunFileIfExists(path)).toBe('a,b\n1,2');
    expect(await runFileExists(path)).toBe(true);
  });

  it('propagates failures other than ENOENT', async () => {
    // A directory where a file was expected → EISDIR, not "absent".
    await expect(readRunFileIfExists(dir)).rejects.toMatchObject({
      code: 'EISDIR',
    });
  });
});

describe('readOwnedRunMetadata', () => {
  const write = (metadata: unknown) =>
    writeFile(
      join(dir, 'metadata.json'),
      typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
    );

  it('returns the metadata for the owner', async () => {
    await write({ userId: 'u1', oc: 'OCA', documentBlobPaths: ['x.pdf'] });
    const result = await readOwnedRunMetadata(dir, 'u1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.metadata.oc).toBe('OCA');
      expect(result.metadata.documentBlobPaths).toEqual(['x.pdf']);
    }
  });

  it.each([
    ['a different user', { userId: 'u1' }, 'u2'],
    ['a run with no owner recorded', { oc: 'OCA' }, 'u1'],
    ['the legacy "unknown" owner', { userId: 'unknown' }, 'unknown'],
    ['malformed metadata', '{not json', 'u1'],
  ])('reads as not found for %s', async (_label, metadata, userId) => {
    await write(metadata);
    expect(await readOwnedRunMetadata(dir, userId)).toEqual({
      ok: false,
      status: 404,
      error: 'Run not found',
    });
  });

  it('reads as not found when there is no metadata file', async () => {
    expect(await readOwnedRunMetadata(dir, 'u1')).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('reads as not found for a caller without an id', async () => {
    await write({ userId: 'u1' });
    expect(await readOwnedRunMetadata(dir, undefined)).toMatchObject({
      ok: false,
    });
  });
});

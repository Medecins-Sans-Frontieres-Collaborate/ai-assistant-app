import {
  __resetGlobalAdminSnapshotForTests,
  isConfigGlobalAdmin,
  isGlobalAdminSnapshotLoaded,
  publishGlobalAdminSnapshot,
} from '@/lib/services/admin/globalAdminsSnapshot';

import { beforeEach, describe, expect, it } from 'vitest';

describe('admin/globalAdminsSnapshot', () => {
  beforeEach(() => {
    __resetGlobalAdminSnapshotForTests();
  });

  it('is cold and grants nobody before anything is published', () => {
    // Cold = env-only: the snapshot can fail to recognise a config admin but
    // must never grant, which is what keeps AGENT_ACCESS_ADMINS un-lockable.
    expect(isGlobalAdminSnapshotLoaded()).toBe(false);
    expect(isConfigGlobalAdmin('admin@example.com')).toBe(false);
    expect(isConfigGlobalAdmin('')).toBe(false);
  });

  it('publishes canonicalized mails and drops empties', () => {
    publishGlobalAdminSnapshot(['  Admin@Example.COM ', '', '   ', 'b@x.org']);

    expect(isGlobalAdminSnapshotLoaded()).toBe(true);
    expect(isConfigGlobalAdmin('admin@example.com')).toBe(true);
    expect(isConfigGlobalAdmin('b@x.org')).toBe(true);
    // The reader is expected to canonicalize first — it does not re-trim.
    expect(isConfigGlobalAdmin('Admin@Example.COM')).toBe(false);
    expect(isConfigGlobalAdmin('')).toBe(false);
  });

  it('replaces rather than merges on re-publish (a removed admin is gone)', () => {
    publishGlobalAdminSnapshot(['a@x.org', 'b@x.org']);
    publishGlobalAdminSnapshot(['b@x.org']);

    expect(isConfigGlobalAdmin('a@x.org')).toBe(false);
    expect(isConfigGlobalAdmin('b@x.org')).toBe(true);
  });

  it('an empty publish is a loaded, empty roster (no roster authored yet)', () => {
    publishGlobalAdminSnapshot([]);

    expect(isGlobalAdminSnapshotLoaded()).toBe(true);
    expect(isConfigGlobalAdmin('a@x.org')).toBe(false);
  });

  it('reset returns the module to its cold state', () => {
    publishGlobalAdminSnapshot(['a@x.org']);
    __resetGlobalAdminSnapshotForTests();

    expect(isGlobalAdminSnapshotLoaded()).toBe(false);
    expect(isConfigGlobalAdmin('a@x.org')).toBe(false);
  });
});

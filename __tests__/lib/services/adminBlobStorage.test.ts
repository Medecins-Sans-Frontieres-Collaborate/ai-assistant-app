import { resolveAdminStorageLocation } from '@/lib/services/adminBlobStorage';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Resolution rules for the centralized admin storage location:
 * EU account by default (residency), dedicated lifecycle-free container,
 * explicit env overrides win.
 */

const envMock = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
}));

vi.mock('@/config/environment', () => envMock);

describe('resolveAdminStorageLocation', () => {
  beforeEach(() => {
    envMock.env = {};
  });

  it('defaults to the EU account and the dedicated admin container', () => {
    envMock.env = {
      AZURE_BLOB_STORAGE_NAME: 'usaccount',
      AZURE_BLOB_STORAGE_NAME_EU: 'euaccount',
      // The shared-container fallbacks must NOT leak in — the whole point
      // is escaping ai-portal-images and its 5-day lifecycle delete.
      AZURE_BLOB_STORAGE_CONTAINER: 'shared',
      AZURE_BLOB_STORAGE_IMAGE_CONTAINER: 'ai-portal-images',
    };
    expect(resolveAdminStorageLocation()).toEqual({
      accountName: 'euaccount',
      containerName: 'ai-portal-admin',
    });
  });

  it('honors explicit admin overrides', () => {
    envMock.env = {
      AZURE_BLOB_STORAGE_NAME: 'usaccount',
      AZURE_BLOB_STORAGE_NAME_EU: 'euaccount',
      AZURE_BLOB_STORAGE_ADMIN_NAME: 'adminaccount',
      AZURE_BLOB_STORAGE_ADMIN_CONTAINER: 'custom-admin',
    };
    expect(resolveAdminStorageLocation()).toEqual({
      accountName: 'adminaccount',
      containerName: 'custom-admin',
    });
  });

  it('falls back to the primary account in single-account environments', () => {
    envMock.env = { AZURE_BLOB_STORAGE_NAME: 'onlyaccount' };
    expect(resolveAdminStorageLocation()).toEqual({
      accountName: 'onlyaccount',
      containerName: 'ai-portal-admin',
    });
  });

  it('reports no account when nothing is configured', () => {
    expect(resolveAdminStorageLocation().accountName).toBeUndefined();
  });
});

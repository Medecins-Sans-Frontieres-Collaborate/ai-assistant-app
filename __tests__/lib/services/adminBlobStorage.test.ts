import {
  __resetAdminStorageStateForTests,
  createAdminBlobStorage,
  resolveAdminStorageLocation,
} from '@/lib/services/adminBlobStorage';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Resolution rules for the centralized admin storage location:
 * EU account by default (residency), dedicated lifecycle-free container,
 * explicit env overrides win. On a data-plane authorization failure the
 * NON-PRODUCTION fallback serves the legacy primary account instead of
 * leaving every admin surface broken.
 */

const envMock = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
}));

vi.mock('@/config/environment', () => envMock);

const blobMock = vi.hoisted(() => ({
  constructed: [] as Array<{ account: string; container: string }>,
  ensureError: null as Error | null,
}));

vi.mock('@/lib/utils/server/blob/blob', () => ({
  AzureBlobStorage: class {
    constructor(account: string, container: string) {
      blobMock.constructed.push({ account, container });
    }
    ensureContainerExists() {
      return blobMock.ensureError
        ? Promise.reject(blobMock.ensureError)
        : Promise.resolve();
    }
  },
}));

function authError(): Error {
  return Object.assign(
    new Error(
      'This request is not authorized to perform this operation using this permission.',
    ),
    { statusCode: 403 },
  );
}

describe('resolveAdminStorageLocation', () => {
  beforeEach(() => {
    envMock.env = {};
    blobMock.constructed = [];
    blobMock.ensureError = null;
    __resetAdminStorageStateForTests();
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

describe('dev fallback on authorization failure', () => {
  beforeEach(() => {
    envMock.env = {
      AZURE_BLOB_STORAGE_NAME: 'legacyaccount',
      AZURE_BLOB_STORAGE_NAME_EU: 'euaccount',
    };
    blobMock.constructed = [];
    blobMock.ensureError = null;
    __resetAdminStorageStateForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves the legacy account after the resolved account denies access', async () => {
    blobMock.ensureError = authError();
    createAdminBlobStorage();
    await vi.waitFor(() =>
      expect(resolveAdminStorageLocation()).toEqual({
        accountName: 'legacyaccount',
        containerName: 'ai-portal-admin',
        devFallbackFrom: 'euaccount',
      }),
    );
    blobMock.ensureError = null;
    createAdminBlobStorage();
    expect(blobMock.constructed.at(-1)).toEqual({
      account: 'legacyaccount',
      container: 'ai-portal-admin',
    });
  });

  it('never engages in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    blobMock.ensureError = authError();
    createAdminBlobStorage();
    await new Promise((r) => setTimeout(r, 10));
    expect(resolveAdminStorageLocation().accountName).toBe('euaccount');
  });

  it('does not engage on non-authorization failures', async () => {
    blobMock.ensureError = Object.assign(new Error('ECONNRESET'), {
      statusCode: 500,
    });
    createAdminBlobStorage();
    await new Promise((r) => setTimeout(r, 10));
    expect(resolveAdminStorageLocation().accountName).toBe('euaccount');
  });

  it('does not engage when no distinct legacy account exists', async () => {
    envMock.env = { AZURE_BLOB_STORAGE_NAME: 'onlyaccount' };
    blobMock.ensureError = authError();
    createAdminBlobStorage();
    await new Promise((r) => setTimeout(r, 10));
    const location = resolveAdminStorageLocation();
    expect(location.accountName).toBe('onlyaccount');
    expect(location.devFallbackFrom).toBeUndefined();
  });
});

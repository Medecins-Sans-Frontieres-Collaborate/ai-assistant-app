import { classifyStorageError } from '@/lib/utils/server/blob/storageErrors';

import { describe, expect, it } from 'vitest';

describe('classifyStorageError', () => {
  it('classifies network errors as storage_unreachable (503)', () => {
    for (const code of [
      'ENOTFOUND',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EAI_AGAIN',
    ]) {
      const result = classifyStorageError({ code });
      expect(result.errorClass).toBe('storage_unreachable');
      expect(result.status).toBe(503);
    }
  });

  it('classifies a storage firewall 403 as storage_forbidden (502)', () => {
    // The EU-upload outage: firewall rejects at the network layer with 403
    // AuthorizationFailure before auth is evaluated — a config fault, not the user's.
    const result = classifyStorageError({
      statusCode: 403,
      code: 'AuthorizationFailure',
    });
    expect(result.errorClass).toBe('storage_forbidden');
    expect(result.status).toBe(502);
    expect(result.message).not.toMatch(/failed to upload file/i);
  });

  it('classifies RBAC permission mismatch as storage_forbidden', () => {
    const result = classifyStorageError({
      statusCode: 403,
      code: 'AuthorizationPermissionMismatch',
    });
    expect(result.errorClass).toBe('storage_forbidden');
  });

  it('classifies a missing container/account as storage_not_found (502)', () => {
    const result = classifyStorageError({
      statusCode: 404,
      code: 'ContainerNotFound',
    });
    expect(result.errorClass).toBe('storage_not_found');
    expect(result.status).toBe(502);
  });

  it('falls back to unknown (500) for unrecognized errors', () => {
    expect(classifyStorageError(new Error('boom')).errorClass).toBe('unknown');
    expect(classifyStorageError(new Error('boom')).status).toBe(500);
    expect(classifyStorageError(null).errorClass).toBe('unknown');
    expect(classifyStorageError(undefined).errorClass).toBe('unknown');
  });
});

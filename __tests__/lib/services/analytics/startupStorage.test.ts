import {
  DELIVERY_CREATED_BY_APP,
  DELIVERY_CREATED_BY_KEY,
  DeliveryContainerAdmin,
  ensureDeliveryContainer,
  readDeliveryContainerOrigin,
} from '@/lib/services/analytics/deliveryStore';
import {
  AnalyticsStorageStartupDeps,
  ensureAnalyticsStorage,
} from '@/lib/services/analytics/startupStorage';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The startup backstop creates missing analytics containers and never
 * touches existing ones; the stamp it leaves is what lets the health view
 * tell "the app had to make this" from "Terraform made this".
 */

/** A container that behaves like the service: create never overwrites. */
function fakeContainer(initial: Record<string, string> | null) {
  let metadata = initial;
  const admin: DeliveryContainerAdmin = {
    async ensureContainerExists(stamp) {
      if (metadata !== null) return false;
      metadata = { ...(stamp ?? {}) };
      return true;
    },
    async getContainerMetadata() {
      return metadata;
    },
  };
  return admin;
}

describe('delivery container ensure and origin', () => {
  it('stamps a container it creates, and reads it back as made by the app', async () => {
    const container = fakeContainer(null);
    await expect(readDeliveryContainerOrigin(container)).resolves.toBe(
      'missing',
    );
    await expect(ensureDeliveryContainer(container)).resolves.toBe(true);
    await expect(container.getContainerMetadata()).resolves.toEqual({
      [DELIVERY_CREATED_BY_KEY]: DELIVERY_CREATED_BY_APP,
    });
    await expect(readDeliveryContainerOrigin(container)).resolves.toBe('app');
  });

  it('leaves an existing container unstamped, so it reads as infrastructure', async () => {
    const container = fakeContainer({ env: 'dev' });
    await expect(ensureDeliveryContainer(container)).resolves.toBe(false);
    await expect(container.getContainerMetadata()).resolves.toEqual({
      env: 'dev',
    });
    await expect(readDeliveryContainerOrigin(container)).resolves.toBe(
      'infrastructure',
    );
  });
});

describe('ensureAnalyticsStorage', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
  });

  function deps(
    overrides: Partial<AnalyticsStorageStartupDeps> = {},
  ): AnalyticsStorageStartupDeps {
    return {
      accountConfigured: () => true,
      ensureAdmin: vi.fn(async () => true),
      ensureDelivery: vi.fn(async () => false),
      deliveryContainerName: () => 'ai-portal-analytics',
      ...overrides,
    };
  }

  it('does nothing without a storage account', async () => {
    const d = deps({ accountConfigured: () => false });
    await expect(ensureAnalyticsStorage(d)).resolves.toEqual({
      admin: 'skipped',
      delivery: 'skipped',
    });
    expect(d.ensureAdmin).not.toHaveBeenCalled();
    expect(d.ensureDelivery).not.toHaveBeenCalled();
  });

  it('is quiet when both containers already exist', async () => {
    await expect(ensureAnalyticsStorage(deps())).resolves.toEqual({
      admin: 'ready',
      delivery: 'existed',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns, naming the container, when it had to create the delivery container', async () => {
    const result = await ensureAnalyticsStorage(
      deps({ ensureDelivery: async () => true }),
    );
    expect(result.delivery).toBe('created');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "Created the missing delivery container 'ai-portal-analytics'",
    );
  });

  it('never throws: failures are reported per container', async () => {
    const denied = Object.assign(
      new Error('This request is not authorized to perform this operation.'),
      { statusCode: 403 },
    );
    const result = await ensureAnalyticsStorage(
      deps({
        ensureAdmin: async () => {
          throw new Error('no account');
        },
        ensureDelivery: async () => {
          throw denied;
        },
      }),
    );
    expect(result).toEqual({ admin: 'failed', delivery: 'failed' });
    expect(warn.mock.calls[0].join(' ')).toContain(
      'Storage Blob Data Contributor',
    );
  });

  it('reports an admin ensure that logged its own failure as failed', async () => {
    const result = await ensureAnalyticsStorage(
      deps({ ensureAdmin: async () => false }),
    );
    expect(result.admin).toBe('failed');
  });
});

/** Observation API preserves raw deployment state and distinguishes failed refreshes. */
import { ModelDiscoveryService } from '@/lib/services/models/ModelDiscoveryService';

import { afterEach, describe, expect, it, vi } from 'vitest';

const path =
  '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/eu';
const deployment = {
  name: 'classifier',
  sku: { name: 'DataZoneStandard' },
  properties: {
    model: { name: 'gpt-6-new-small', version: 'v1', format: 'OpenAI' },
    provisioningState: 'Disabled',
    capabilities: { chatCompletion: 'true' },
  },
};
afterEach(() => vi.restoreAllMocks());
describe('authoritative inventory observations', () => {
  it('retains disabled deployments for diagnosis without exposing them in normal chat discovery', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes('/deployments?')
              ? { value: [deployment] }
              : String(url).includes('/models?')
                ? { value: [] }
                : { location: 'swedencentral' },
          ),
        ),
    );
    const service = new ModelDiscoveryService();
    const observation = await service.observeDeployments('token', path);
    expect(observation.status).toBe('current');
    expect(observation.location).toBe('swedencentral');
    expect(observation.models[0].provisioningState).toBe('Disabled');
    expect(await service.listDeployedModels('token', path)).toEqual([]);
  });
  it('retains successful facts but marks failed refreshes stale', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes('/deployments?')
              ? {
                  value: [
                    {
                      ...deployment,
                      properties: {
                        ...deployment.properties,
                        provisioningState: 'Succeeded',
                      },
                    },
                  ],
                }
              : String(url).includes('/models?')
                ? { value: [] }
                : { location: 'swedencentral' },
          ),
        ),
    );
    const service = new ModelDiscoveryService();
    const first = await service.observeDeployments('token', path);
    fetch.mockResolvedValue(new Response('unavailable', { status: 503 }));
    const stale = await service.observeDeployments('token', path, true);
    expect(stale.status).toBe('stale');
    expect(stale.fetchedAt).toBe(first.fetchedAt);
    expect(stale.location).toBe(first.location);
    expect(stale.models).toEqual(first.models);
  });
  it('marks an initial outage unavailable, not an authoritative empty inventory', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('unavailable', { status: 503 }),
    );
    const result = await new ModelDiscoveryService().observeDeployments(
      'token',
      path,
    );
    expect(result).toMatchObject({
      status: 'unavailable',
      error: 'inventory_refresh_failed',
    });
    expect(result.fetchedAt).toBeUndefined();
  });
});

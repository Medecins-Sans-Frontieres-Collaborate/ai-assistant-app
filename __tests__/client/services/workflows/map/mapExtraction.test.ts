import { extractMapFeatures } from '@/client/services/workflows/map/mapExtraction';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();

describe('extractMapFeatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the extraction contract and returns typed results', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          features: [{ name: 'Gao', lat: 16.27, lon: -0.04 }],
          connections: [{ fromName: 'Gao', toName: 'Kidal', kind: 'route' }],
          sources: [{ number: 1, title: 'Report', url: 'https://x' }],
          truncatedSource: true,
        },
      }),
    });

    const result = await extractMapFeatures(
      { searchQuery: 'health facilities in Gao' },
      { existingNames: ['Kidal'], modelId: 'gpt-5.2' },
    );

    expect(mockFetch).toHaveBeenCalledWith('/api/workflows/map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        searchQuery: 'health facilities in Gao',
        existingNames: ['Kidal'],
        modelId: 'gpt-5.2',
      }),
    });
    expect(result.features).toHaveLength(1);
    expect(result.connections[0]).toMatchObject({ fromName: 'Gao' });
    expect(result.citations[0].url).toBe('https://x');
    expect(result.truncatedSource).toBe(true);
  });

  it('surfaces the server error message on failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: 'Search unavailable' }),
    });

    await expect(
      extractMapFeatures({ sourceText: 'text' }, { existingNames: [] }),
    ).rejects.toThrow('Search unavailable');
  });

  it('falls back to a status message on unparseable responses', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('bad json');
      },
    });

    await expect(
      extractMapFeatures({ sourceText: 'text' }, { existingNames: [] }),
    ).rejects.toThrow('Request failed (502)');
  });
});

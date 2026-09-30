import { NextRequest } from 'next/server';

import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';

import { GET } from '@/app/api/channel-sets/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const workflowEnabled = vi.hoisted(() => vi.fn());
const loadSets = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/workflows/policy/guard', () => ({
  isWorkflowEnabled: workflowEnabled,
}));
vi.mock('@/lib/services/workflows/channelDrafter/channelSetService', () => ({
  loadChannelSetsFor: loadSets,
}));

const set = (id: string, grant: string, isDefault = false) => ({
  id,
  name: id,
  language: '',
  description: '',
  isDefault,
  grant,
  defaults: { channelIds: [], articleLink: true, guideIds: [] },
  defaultVoices: {},
  channels: [{ ...getChannelProfile('x')!, publishTarget: 'hs-secret' }],
});

describe('GET /api/channel-sets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: 'u1', mail: 'a@example.org' } });
    workflowEnabled.mockResolvedValue(true);
  });

  it('lists the sets, suggests the most specifically shared one, and strips Hootsuite ids', async () => {
    loadSets.mockResolvedValue([
      set('default', 'everyone'),
      set('set-no', 'domain'),
    ]);
    const response = await GET(
      new NextRequest('https://app.example.com/api/channel-sets'),
    );
    const json = await response.json();
    expect(json.data.suggestedSetId).toBe('set-no');
    expect(json.data.sets.map((s: { id: string }) => s.id)).toEqual([
      'default',
      'set-no',
    ]);
    expect(JSON.stringify(json)).not.toContain('hs-secret');
    expect(loadSets).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'discovery',
    );
  });

  it('lists nothing when the workflow is switched off', async () => {
    workflowEnabled.mockResolvedValue(false);
    const json = await (
      await GET(new NextRequest('https://app.example.com/api/channel-sets'))
    ).json();
    expect(json.data).toEqual({ sets: [], suggestedSetId: null });
    expect(loadSets).not.toHaveBeenCalled();
  });
});

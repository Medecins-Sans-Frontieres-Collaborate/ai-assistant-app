import { NextRequest } from 'next/server';

import { AgentAccessConfig } from '@/lib/services/agentAccess/types';

import {
  MAX_GUIDE_ENTRIES,
  MAX_GUIDE_NAME_CHARS,
} from '@/lib/utils/shared/review/guideCriteria';

import { parseJsonResponse } from '../helpers';

import { POST } from '@/app/api/agent-access/guides/generate/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const serviceIsEnabled = vi.hoisted(() => vi.fn());
const serviceEnsureFresh = vi.hoisted(() => vi.fn());
const serviceGetSnapshot = vi.hoisted(() => vi.fn());
const mockCallStructured = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
  AGENT_ACCESS_ADMINS: 'global@example.com',
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/environment', () => ({ env: mockEnv }));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: {
    getInstance: () => ({
      isEnabled: serviceIsEnabled,
      ensureFresh: serviceEnsureFresh,
      getSnapshot: serviceGetSnapshot,
    }),
  },
}));
vi.mock('@/lib/services/workflows/shared/workflowLlm', () => ({
  callStructured: mockCallStructured,
  createAzureClient: vi.fn(() => ({})),
}));

const emptyConfig: AgentAccessConfig = {
  version: 1,
  localAdmins: [],
  updatedBy: 'global@example.com',
  updatedAt: '2026-07-23T00:00:00.000Z',
};

function generateRequest(body: unknown): NextRequest {
  return new NextRequest(
    'https://app.example.com/api/agent-access/guides/generate',
    { method: 'POST', body: JSON.stringify(body) },
  );
}

describe('/api/agent-access/guides/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    serviceIsEnabled.mockReturnValue(true);
    serviceGetSnapshot.mockReturnValue({ config: emptyConfig });
    mockAuth.mockResolvedValue({
      user: { id: 'u1', mail: 'global@example.com' },
    });
    mockCallStructured.mockResolvedValue({
      name: 'Generated name',
      description: 'Generated description',
      body: '# Generated rules',
    });
  });

  it('404s for everyone while the feature is disabled', async () => {
    serviceIsEnabled.mockReturnValue(false);
    const response = await POST(
      generateRequest({ kind: 'style', prompt: 'a style guide' }),
    );
    expect(response.status).toBe(404);
  });

  it('401s an unauthenticated caller and 403s a non-admin', async () => {
    mockAuth.mockResolvedValueOnce(null);
    expect(
      (await POST(generateRequest({ kind: 'style', prompt: 'x' }))).status,
    ).toBe(401);

    mockAuth.mockResolvedValue({
      user: { id: 'u2', mail: 'nobody@example.com' },
    });
    expect(
      (await POST(generateRequest({ kind: 'style', prompt: 'x' }))).status,
    ).toBe(403);
    expect(mockCallStructured).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind and an empty prompt', async () => {
    expect(
      (await POST(generateRequest({ kind: 'grammar', prompt: 'x' }))).status,
    ).toBe(400);
    expect(
      (await POST(generateRequest({ kind: 'style', prompt: '  ' }))).status,
    ).toBe(400);
  });

  it('returns normalized fields for a body kind', async () => {
    const response = await POST(
      generateRequest({ kind: 'style', prompt: 'French style guide' }),
    );
    const parsed = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(parsed.data.fields).toEqual({
      name: 'Generated name',
      description: 'Generated description',
      body: '# Generated rules',
    });
  });

  it('normalizes strict-schema empty strings to absent and clamps caps', async () => {
    mockCallStructured.mockResolvedValue({
      // Empty = "current name should stand" in the strict-schema convention.
      name: '',
      description: 'x'.repeat(400),
      entries: [
        ...Array.from({ length: MAX_GUIDE_ENTRIES + 20 }, (_, i) => ({
          source: `term-${i}`,
          target: `translation-${i}`,
          note: '',
        })),
        // Blank rows from the model are dropped, not stored.
        { source: '  ', target: 'x', note: '' },
      ],
    });

    const response = await POST(
      generateRequest({ kind: 'terminology', prompt: 'org glossary' }),
    );
    const parsed = await parseJsonResponse(response);

    expect(response.status).toBe(200);
    expect(parsed.data.fields.name).toBeUndefined();
    expect(parsed.data.fields.description).toHaveLength(300);
    expect(parsed.data.fields.entries).toHaveLength(MAX_GUIDE_ENTRIES);
    expect(parsed.data.fields.entries[0]).toEqual({
      source: 'term-0',
      target: 'translation-0',
      note: undefined,
    });
  });

  it('passes current form values through to the revise prompt', async () => {
    await POST(
      generateRequest({
        kind: 'tone',
        prompt: 'make it warmer',
        current: { voiceRules: 'Be terse.' },
      }),
    );

    expect(mockCallStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('Be terse.'),
        user: 'make it warmer',
      }),
    );
  });

  it('caps the name length', async () => {
    mockCallStructured.mockResolvedValue({
      name: 'n'.repeat(MAX_GUIDE_NAME_CHARS + 50),
      description: '',
      body: 'rules',
    });
    const response = await POST(
      generateRequest({ kind: 'compliance', prompt: 'rules' }),
    );
    const parsed = await parseJsonResponse(response);
    expect(parsed.data.fields.name).toHaveLength(MAX_GUIDE_NAME_CHARS);
  });
});

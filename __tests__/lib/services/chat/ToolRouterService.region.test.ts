/**
 * Region-pinned auxiliary routing (residency): a pinned request runs on the
 * regional client and NEVER falls back to the unpinned default. When the
 * regional client is missing or cannot serve the router model, the decision
 * degrades to "no tools" with a reason and the region attached, so the
 * enricher can name the failing endpoint instead of a generic outage.
 */
import {
  AUXILIARY_ROUTER_MODEL,
  AuxiliaryEndpointMissingError,
  ToolRouterService,
  describeAuxiliaryFailure,
} from '@/lib/services/chat/ToolRouterService';

import { Message, MessageType } from '@/types/chat';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@opentelemetry/api', () => ({
  SpanStatusCode: { OK: 1, ERROR: 2 },
  trace: {
    getTracer: () => ({
      startActiveSpan: (
        _name: string,
        _options: unknown,
        fn: (span: unknown) => unknown,
      ) =>
        fn({
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          recordException: vi.fn(),
          end: vi.fn(),
        }),
    }),
  },
}));

const decision = (needsWebSearch: boolean) => ({
  choices: [
    {
      message: {
        content: JSON.stringify({
          needsWebSearch,
          searchQuery: needsWebSearch ? 'sudan news' : '',
          additionalSearchQueries: [],
          searchRecency: 'day',
          searchComprehensive: false,
          searchCategory: 'news',
          searchLanguage: 'en',
        }),
      },
    },
  ],
});

function client(impl: () => Promise<unknown>) {
  return { chat: { completions: { create: vi.fn(impl) } } } as any;
}

const messages: Message[] = [
  {
    role: 'user',
    content: 'what is happening in sudan',
    messageType: MessageType.TEXT,
  },
];
const request = { messages, currentMessage: 'what is happening in sudan' };

describe('ToolRouterService region pinning', () => {
  let defaultClient: any;
  beforeEach(() => {
    defaultClient = client(async () => decision(true));
  });

  it('uses the default client when no region is pinned', async () => {
    const service = new ToolRouterService(defaultClient);
    const result = await service.determineTool(request);
    expect(result.tools).toEqual(['web_search']);
    expect(defaultClient.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  it('runs a pinned request on the regional client and never on the default', async () => {
    const eu = client(async () => decision(true));
    const service = new ToolRouterService(defaultClient, (region) =>
      region === 'EU' ? eu : undefined,
    );
    const result = await service.determineTool({ ...request, region: 'EU' });
    expect(result.tools).toEqual(['web_search']);
    expect(result.degraded).toBeUndefined();
    expect(eu.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(eu.chat.completions.create.mock.calls[0][0].model).toBe(
      AUXILIARY_ROUTER_MODEL,
    );
    expect(defaultClient.chat.completions.create).not.toHaveBeenCalled();
  });

  it('degrades with endpoint_missing when the pinned region has no client (no default fallback)', async () => {
    const service = new ToolRouterService(defaultClient, () => undefined);
    const result = await service.determineTool({ ...request, region: 'EU' });
    expect(result.tools).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('endpoint_missing');
    expect(result.degradedRegion).toBe('EU');
    expect(defaultClient.chat.completions.create).not.toHaveBeenCalled();
  });

  it('degrades with deployment_missing when the regional account 404s the router model', async () => {
    const eu = client(async () => {
      throw Object.assign(new Error('404 DeploymentNotFound'), { status: 404 });
    });
    const service = new ToolRouterService(defaultClient, () => eu);
    const result = await service.determineTool({ ...request, region: 'EU' });
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('deployment_missing');
    expect(result.degradedRegion).toBe('EU');
    expect(defaultClient.chat.completions.create).not.toHaveBeenCalled();
  });

  it('degrades with unauthorized on 401/403 from the regional account', async () => {
    const eu = client(async () => {
      throw Object.assign(new Error('PermissionDenied'), { status: 401 });
    });
    const service = new ToolRouterService(defaultClient, () => eu);
    const result = await service.determineTool({ ...request, region: 'EU' });
    expect(result.degradedReason).toBe('unauthorized');
  });

  it('skills-only selection carries the same degradation shape', async () => {
    const service = new ToolRouterService(defaultClient, () => undefined);
    const result = await service.determineSkills({
      messages,
      currentMessage: 'x',
      region: 'EU',
      skillCatalog: [{ id: 'gdpr', name: 'GDPR', description: 'privacy' }],
    });
    expect(result).toEqual({
      relevantSkills: [],
      degraded: true,
      degradedReason: 'endpoint_missing',
      degradedRegion: 'EU',
    });
    expect(defaultClient.chat.completions.create).not.toHaveBeenCalled();
  });
});

describe('describeAuxiliaryFailure', () => {
  it('names the remedy for a missing regional endpoint', () => {
    const failure = describeAuxiliaryFailure(
      new AuxiliaryEndpointMissingError('EU'),
      'EU',
    );
    expect(failure.reason).toBe('endpoint_missing');
    expect(failure.message).toContain('AZURE_AI_FOUNDRY_ENDPOINT_EU');
  });

  it('maps a 404 to a missing deployment and names the model', () => {
    const failure = describeAuxiliaryFailure(
      Object.assign(new Error('Resource not found'), { status: 404 }),
      'EU',
    );
    expect(failure.reason).toBe('deployment_missing');
    expect(failure.message).toContain(AUXILIARY_ROUTER_MODEL);
    expect(failure.message).toContain('EU');
  });

  it('maps timeouts and unknown errors', () => {
    expect(
      describeAuxiliaryFailure(new Error('Request timed out')).reason,
    ).toBe('timeout');
    expect(describeAuxiliaryFailure(new Error('boom')).reason).toBe('provider');
  });
});

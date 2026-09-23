import { NextRequest } from 'next/server';

import { getChannelProfile } from '@/lib/utils/shared/drafter/channels/channelProfiles';
import { briefDigestFor } from '@/lib/utils/shared/drafter/core/versions';

import { parseJsonResponse } from '../../helpers';

import { GET, POST } from '@/app/api/workflows/channel-drafter/publish/route';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const workflowEnabled = vi.hoisted(() => vi.fn());
const loadProfiles = vi.hoisted(() => vi.fn());
const evaluateAccess = vi.hoisted(() => vi.fn());
const connectMcp = vi.hoisted(() => vi.fn());
const emitAccessAudit = vi.hoisted(() => vi.fn());
const publishing = vi.hoisted(() => ({
  config: {
    catalogKey: 'hootsuitePerch',
    toolName: '',
    textArgument: '',
    targetArgument: '',
    targetIsList: false,
    fixedArguments: {} as Record<string, string | number | boolean>,
    allowVouched: false,
  },
}));

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/config/publishing', () => ({
  get HOOTSUITE_PUBLISHING() {
    return publishing.config;
  },
  isPublishingConfigured: () =>
    publishing.config.toolName !== '' && publishing.config.textArgument !== '',
}));
vi.mock('@/lib/services/workflows/policy/guard', () => ({
  isWorkflowEnabled: workflowEnabled,
  workflowDisabledResponse: () => new Response('disabled', { status: 403 }),
}));
vi.mock('@/lib/services/workflows/channelDrafter/channelSetService', () => ({
  // The route reads sets; the test still thinks in profiles, which the
  // default set carries.
  loadChannelSetsFor: async (...args: unknown[]) => [
    {
      id: 'default',
      name: 'Default',
      language: '',
      description: '',
      isDefault: true,
      grant: 'everyone',
      defaults: { channelIds: [], articleLink: true, guideIds: [] },
      defaultVoices: {},
      channels: await loadProfiles(...args),
    },
  ],
}));
vi.mock('@/lib/services/agentAccess/AgentAccessService', () => ({
  AgentAccessService: { getInstance: () => ({ evaluateAccess }) },
  emitAccessAudit,
}));
vi.mock('@/lib/services/mcp/McpClientService', () => ({ connectMcp }));
vi.mock('@/lib/services/mcp/connectorResolution', () => ({
  createConnectorResolver: vi.fn().mockResolvedValue(() => null),
}));
vi.mock('@/config/mcpCatalog', () => ({
  resolveMcpServers: (servers: Array<{ catalogKey?: string }>) =>
    servers.map((server) => ({
      label: 'Hootsuite Perch',
      url: 'https://mcp.hootsuite.com/perch',
      catalogKey: server.catalogKey,
    })),
}));
vi.mock('@/lib/services/shared/RateLimiter', () => ({
  RateLimiter: {
    createScoped: () => ({ checkLimit: () => ({ allowed: true }) }),
  },
}));

const QUOTE = 'We had no clean water for eleven days';
const POST_TEXT = `“${QUOTE}” said a nurse.`;
const linkedin = getChannelProfile('linkedin')!;

const brief = {
  keyMessage: 'Water is life',
  language: 'English',
  links: [],
  items: [
    {
      id: 'q1',
      kind: 'quote' as const,
      text: QUOTE,
      verified: 'verbatim' as const,
      decision: 'included' as const,
    },
  ],
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 'linkedin',
    version: {
      segments: [{ id: 's1', text: POST_TEXT, usedItemIds: ['q1'] }],
      briefDigest: briefDigestFor(
        {
          ...brief,
          rev: 0,
          items: brief.items.map((i) => ({ ...i, provenance: [] })),
        },
        ['q1'],
      ),
      approvalTexts: [POST_TEXT],
      hasPendingSuggestions: false,
      hasProposal: false,
    },
    brief,
    server: {
      id: 'srv1',
      name: 'Hootsuite',
      catalogKey: 'hootsuitePerch',
      authToken: 'secret-token',
    },
    ...overrides,
  };
}

const url = 'https://app.example.com/api/workflows/channel-drafter/publish';
const post = (payload: unknown) =>
  POST(new NextRequest(url, { method: 'POST', body: JSON.stringify(payload) }));

const callTool = vi.fn();
const close = vi.fn();
const listTools = vi.fn();

describe('/api/workflows/channel-drafter/publish', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    publishing.config.toolName = 'save_draft';
    publishing.config.textArgument = 'text';
    publishing.config.targetArgument = '';
    publishing.config.fixedArguments = { state: 'DRAFT' };
    mockAuth.mockResolvedValue({ user: { id: 'u1', mail: 'a@example.org' } });
    workflowEnabled.mockResolvedValue(true);
    loadProfiles.mockResolvedValue([linkedin]);
    evaluateAccess.mockImplementation(({ agentName }) =>
      agentName === '*'
        ? { decision: 'allow', reason: 'allow-user' }
        : { decision: 'allow', reason: 'no-rule' },
    );
    listTools.mockResolvedValue([{ name: 'save_draft' }]);
    callTool.mockResolvedValue({ text: 'ok', isError: false });
    connectMcp.mockResolvedValue({ listTools, callTool, close });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('ships dark: with no tool configured it offers nothing and sends nothing', async () => {
    publishing.config.toolName = '';
    const access = await parseJsonResponse(await GET(new NextRequest(url)));
    expect(access.data).toEqual({ configured: false, channels: [] });
    expect((await post(body())).status).toBe(404);
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('lists only the channels this user was granted', async () => {
    const access = await parseJsonResponse(await GET(new NextRequest(url)));
    expect(access.data).toEqual({
      configured: true,
      channels: ['default/linkedin'],
    });

    evaluateAccess.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
    const none = await parseJsonResponse(await GET(new NextRequest(url)));
    expect(none.data.channels).toEqual([]);
  });

  it('is scoped to the set: a channel of a set the caller may not use is unknown', async () => {
    expect((await post(body({ setId: 'set-other' }))).status).toBe(404);
    expect((await post(body({ setId: 'default' }))).status).toBe(200);
    expect(connectMcp).toHaveBeenCalledTimes(1);
  });

  it('refuses a user no rule grants, before connecting to anything', async () => {
    evaluateAccess.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
    expect((await post(body())).status).toBe(403);
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('audits the decision either way: who, which channel, which rule', async () => {
    await post(body());
    expect(emitAccessAudit).toHaveBeenCalledTimes(1);
    expect(emitAccessAudit).toHaveBeenCalledWith({
      userMail: 'a@example.org',
      agentName: 'default/linkedin',
      source: 'publish',
      decision: 'allow',
      reason: 'all:allow-user',
      user: { id: 'u1', mail: 'a@example.org' },
    });

    emitAccessAudit.mockClear();
    evaluateAccess.mockReturnValue({ decision: 'allow', reason: 'no-rule' });
    await post(body());
    expect(emitAccessAudit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'no-grant' }),
    );
    // Neither the post nor the token is part of an audit entry.
    const audited = JSON.stringify(emitAccessAudit.mock.calls);
    expect(audited).not.toContain(QUOTE);
    expect(audited).not.toContain('secret-token');
  });

  it('is a 503 when channel settings cannot be read, never a send', async () => {
    loadProfiles.mockRejectedValue(
      Object.assign(new Error('Channel settings are unavailable'), {
        status: 503,
      }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post(body())).status).toBe(503);
    expect((await GET(new NextRequest(url))).status).toBe(503);
    errorSpy.mockRestore();
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('answers an unknown or restricted channel the same way', async () => {
    loadProfiles.mockResolvedValue([]);
    expect((await post(body())).status).toBe(404);
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('re-runs the gate itself: an unapproved or changed post is not sent', async () => {
    const unapproved = await post(
      body({ version: { ...body().version, approvalTexts: null } }),
    );
    expect(unapproved.status).toBe(409);
    expect((await parseJsonResponse(unapproved)).details).toContain(
      'not-approved',
    );

    const lapsed = await post(
      body({ version: { ...body().version, approvalTexts: ['older text'] } }),
    );
    expect((await parseJsonResponse(lapsed)).details).toContain(
      'approval-lapsed',
    );
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('will not send a post with an invented quotation, whatever the client says', async () => {
    const invented = '“Nobody ever came to help us” said a nurse.';
    const response = await post(
      body({
        version: {
          ...body().version,
          segments: [{ id: 's1', text: invented, usedItemIds: [] }],
          approvalTexts: [invented],
        },
      }),
    );
    expect(response.status).toBe(409);
    expect((await parseJsonResponse(response)).details).toContain('to-fix');
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('does not send threads', async () => {
    const response = await post(
      body({
        version: {
          ...body().version,
          segments: [
            { id: 's1', text: POST_TEXT, usedItemIds: ['q1'] },
            { id: 's2', text: 'Second post.', usedItemIds: [] },
          ],
        },
      }),
    );
    expect(response.status).toBe(409);
    expect((await parseJsonResponse(response)).code).toBe(
      'THREAD_NOT_SUPPORTED',
    );
  });

  const IMAGE = {
    id: 'm1',
    ref: `/api/file/${'a'.repeat(64)}.jpg`,
    name: 'clinic.jpg',
    alt: 'A nurse fills a jerrycan at a standpipe.',
  };
  const withMedia = (media: unknown) =>
    body({
      version: {
        ...body().version,
        segments: [{ id: 's1', text: POST_TEXT, usedItemIds: ['q1'], media }],
      },
    });

  it('refuses a post with images in words, rather than sending it without them', async () => {
    const response = await post(withMedia([IMAGE]));
    expect(response.status).toBe(409);
    const json = await parseJsonResponse(response);
    expect(json.code).toBe('MEDIA_NOT_SUPPORTED');
    expect(json.error).toMatch(/images/u);
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('sends a post whose media list is empty', async () => {
    expect((await post(withMedia([]))).status).toBe(200);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('still validates media: refs, unknown fields, counts and alt length', async () => {
    const bad = [
      [{ ...IMAGE, ref: 'https://evil.example/x.jpg' }],
      [{ ...IMAGE, extra: 'field' }],
      [{ ...IMAGE, alt: 'a'.repeat(2_001) }],
      Array.from({ length: 11 }, (_, index) => ({ ...IMAGE, id: `m${index}` })),
      'not-a-list',
    ];
    for (const media of bad) {
      const response = await post(withMedia(media));
      expect(response.status).toBe(400);
      expect((await parseJsonResponse(response)).details).toContain(
        'version.segments.0.media',
      );
    }
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('only sends through the Hootsuite connector', async () => {
    const response = await post(
      body({ server: { ...body().server, catalogKey: 'somethingElse' } }),
    );
    expect(response.status).toBe(400);
    expect(connectMcp).not.toHaveBeenCalled();
  });

  it('sends exactly the configured arguments and the approved text, then closes', async () => {
    const response = await post(body());
    expect(response.status).toBe(200);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('save_draft', {
      state: 'DRAFT',
      text: POST_TEXT,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('never logs the post, the quotation or the token', async () => {
    await post(body());
    const logged = logSpy.mock.calls.flat().join(' ');
    expect(logged).toContain('SENT');
    expect(logged).toContain('segments=1');
    expect(logged).toContain('textHash=');
    expect(logged).not.toContain(QUOTE);
    expect(logged).not.toContain('secret-token');
  });

  it('fails loudly when the configured tool is not on the server, and still closes', async () => {
    listTools.mockResolvedValue([{ name: 'publish_now' }]);
    const response = await post(body());
    expect(response.status).toBe(502);
    expect((await parseJsonResponse(response)).code).toBe(
      'PUBLISH_TOOL_MISSING',
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports a refusal from Hootsuite as a failure', async () => {
    callTool.mockResolvedValue({ text: 'profile not found', isError: true });
    const response = await post(body());
    expect(response.status).toBe(502);
    expect((await parseJsonResponse(response)).code).toBe('PUBLISH_REJECTED');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('needs a channel’s Hootsuite profile when the tool takes one', async () => {
    publishing.config.targetArgument = 'socialProfileId';
    const missing = await post(body());
    expect((await parseJsonResponse(missing)).code).toBe('NO_PUBLISH_TARGET');

    loadProfiles.mockResolvedValue([{ ...linkedin, publishTarget: '12345' }]);
    await post(body());
    expect(callTool).toHaveBeenCalledWith('save_draft', {
      state: 'DRAFT',
      socialProfileId: '12345',
      text: POST_TEXT,
    });
  });
});

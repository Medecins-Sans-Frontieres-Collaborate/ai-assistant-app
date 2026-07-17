import { ResourceTreeService } from '@/lib/services/agents/ResourceTreeService';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface FetchRule {
  match: (url: string) => boolean;
  respond: (url: string) => Promise<Response> | Response;
}

function jsonOk(value: unknown[]): Response {
  return { ok: true, json: async () => ({ value }) } as Response;
}

function armError(status = 500): Response {
  return {
    ok: false,
    status,
    statusText: 'ERR',
    text: async () => 'boom',
  } as Response;
}

function sub(id: string, name = id) {
  return { subscriptionId: id, displayName: name };
}

function account(subId: string, rg: string, name: string, kind = 'AIServices') {
  return {
    name,
    kind,
    id: `/subscriptions/${subId}/resourceGroups/${rg}/providers/Microsoft.CognitiveServices/accounts/${name}`,
    location: 'westeurope',
  };
}

/**
 * URL-routing fetch stub. Rules are checked in order; unmatched URLs 404.
 */
function stubArmFetch(rules: FetchRule[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => {
    for (const rule of rules) {
      if (rule.match(url)) return rule.respond(url);
    }
    return armError(404);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const subscriptionsRule = (subs: unknown[]): FetchRule => ({
  match: (url) => url.includes('/subscriptions?'),
  respond: () => jsonOk(subs),
});

const accountsRule = (
  accountsBySub: Record<string, unknown[] | 'fail'>,
): FetchRule => ({
  match: (url) =>
    url.includes('/providers/Microsoft.CognitiveServices/accounts?'),
  respond: (url) => {
    const subId = url.match(/\/subscriptions\/([^/]+)\//)?.[1] ?? '';
    const entry = accountsBySub[subId];
    if (entry === 'fail') return armError();
    return jsonOk(entry ?? []);
  },
});

const projectsRule = (
  projectsByAccount: Record<string, string[] | 'fail'>,
): FetchRule => ({
  match: (url) => url.includes('/projects?'),
  respond: (url) => {
    const acct = url.match(/\/accounts\/([^/]+)\/projects\?/)?.[1] ?? '';
    const entry = projectsByAccount[acct];
    if (entry === 'fail') return armError();
    return jsonOk((entry ?? []).map((name) => ({ name: `${acct}/${name}` })));
  },
});

let service: ResourceTreeService;

beforeEach(() => {
  ResourceTreeService.reset();
  service = ResourceTreeService.getInstance();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Pruning ─────────────────────────────────────────────────────────────────

describe('getTree — pruning', () => {
  it('prunes accounts without projects and subscriptions without accounts', async () => {
    stubArmFetch([
      subscriptionsRule([sub('sub-full'), sub('sub-empty'), sub('sub-noproj')]),
      accountsRule({
        'sub-full': [
          account('sub-full', 'rg1', 'acct-with'),
          account('sub-full', 'rg1', 'acct-without'),
          account('sub-full', 'rg1', 'acct-openai', 'OpenAI'),
        ],
        'sub-empty': [],
        'sub-noproj': [account('sub-noproj', 'rg2', 'acct-bare')],
      }),
      projectsRule({
        'acct-with': ['proj-a', 'proj-b'],
        'acct-without': [],
        'acct-bare': [],
      }),
    ]);

    const tree = await service.getTree('token');

    expect(tree.subscriptions).toHaveLength(1);
    expect(tree.subscriptions[0].id).toBe('sub-full');
    expect(tree.subscriptions[0].accounts).toHaveLength(1);
    expect(tree.subscriptions[0].accounts[0]).toMatchObject({
      name: 'acct-with',
      resourceGroup: 'rg1',
      location: 'westeurope',
    });
    expect(
      tree.subscriptions[0].accounts[0].projects.map((p) => p.name),
    ).toEqual(['proj-a', 'proj-b']);
    expect(tree.failedSubscriptions).toEqual([]);
    expect(tree.truncated).toBe(false);
  });

  it('never queries projects for non-AIServices accounts', async () => {
    const fetchMock = stubArmFetch([
      subscriptionsRule([sub('s1')]),
      accountsRule({
        s1: [account('s1', 'rg', 'speech-acct', 'SpeechServices')],
      }),
      projectsRule({}),
    ]);

    const tree = await service.getTree('token');

    expect(tree.subscriptions).toEqual([]);
    const projectCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/projects?'),
    );
    expect(projectCalls).toHaveLength(0);
  });
});

// ── Partial failure ─────────────────────────────────────────────────────────

describe('getTree — partial failure', () => {
  it('reports failed subscriptions and keeps successful ones', async () => {
    stubArmFetch([
      subscriptionsRule([sub('s-ok', 'Good Sub'), sub('s-bad', 'Bad Sub')]),
      accountsRule({
        's-ok': [account('s-ok', 'rg', 'acct1')],
        's-bad': 'fail',
      }),
      projectsRule({ acct1: ['proj'] }),
    ]);

    const tree = await service.getTree('token');

    expect(tree.subscriptions.map((s) => s.id)).toEqual(['s-ok']);
    expect(tree.failedSubscriptions).toEqual([
      { id: 's-bad', name: 'Bad Sub' },
    ]);
  });

  it('treats a failed projects call as an empty account, not a failed subscription', async () => {
    stubArmFetch([
      subscriptionsRule([sub('s1')]),
      accountsRule({
        s1: [account('s1', 'rg', 'acct-ok'), account('s1', 'rg', 'acct-err')],
      }),
      projectsRule({ 'acct-ok': ['proj'], 'acct-err': 'fail' }),
    ]);

    const tree = await service.getTree('token');

    expect(tree.subscriptions[0].accounts.map((a) => a.name)).toEqual([
      'acct-ok',
    ]);
    expect(tree.failedSubscriptions).toEqual([]);
  });
});

// ── Truncation ──────────────────────────────────────────────────────────────

describe('getTree — truncation caps', () => {
  it('caps subscriptions at 50 and flags truncated', async () => {
    const subs = Array.from({ length: 55 }, (_, i) => sub(`s${i}`));
    const fetchMock = stubArmFetch([
      subscriptionsRule(subs),
      accountsRule({}),
      projectsRule({}),
    ]);

    const tree = await service.getTree('token');

    expect(tree.truncated).toBe(true);
    const accountCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/providers/Microsoft.CognitiveServices/accounts?'),
    );
    expect(accountCalls).toHaveLength(50);
  });

  it('caps total account fan-out at 100 and flags truncated', async () => {
    const accounts = Array.from({ length: 110 }, (_, i) =>
      account('s1', 'rg', `acct${i}`),
    );
    const fetchMock = stubArmFetch([
      subscriptionsRule([sub('s1')]),
      accountsRule({ s1: accounts }),
      projectsRule(Object.fromEntries(accounts.map((a) => [a.name, ['proj']]))),
    ]);

    const tree = await service.getTree('token');

    expect(tree.truncated).toBe(true);
    const projectCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/projects?'),
    );
    expect(projectCalls).toHaveLength(100);
    expect(tree.subscriptions[0].accounts).toHaveLength(100);
  });
});

// ── Caching ─────────────────────────────────────────────────────────────────

describe('getTree — cache', () => {
  const singleProjectRules = () => [
    subscriptionsRule([sub('s1')]),
    accountsRule({ s1: [account('s1', 'rg', 'acct')] }),
    projectsRule({ acct: ['proj'] }),
  ];

  it('serves a second call for the same token from cache', async () => {
    const fetchMock = stubArmFetch(singleProjectRules());

    await service.getTree('token');
    const callsAfterFirst = fetchMock.mock.calls.length;
    await service.getTree('token');

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('does not share cache across tokens', async () => {
    const fetchMock = stubArmFetch(singleProjectRules());

    await service.getTree('token-user-a');
    const callsAfterFirst = fetchMock.mock.calls.length;
    await service.getTree('token-user-b');

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst * 2);
  });

  it('refetches after clearCache()', async () => {
    const fetchMock = stubArmFetch(singleProjectRules());

    await service.getTree('token');
    const callsAfterFirst = fetchMock.mock.calls.length;
    service.clearCache();
    await service.getTree('token');

    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst * 2);
  });
});

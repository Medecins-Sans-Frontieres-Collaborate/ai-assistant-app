import {
  AgentAccessService,
  emitAccessAudit,
} from '@/lib/services/agentAccess/AgentAccessService';
import {
  StoredAgentAccessRule,
  StoredPromptAgent,
  listAllPromptAgents,
  listAllRules,
  readConfig,
} from '@/lib/services/agentAccess/accessRulesStore';
import {
  AgentAccessRule,
  AgentAccessType,
  PROMPT_AGENT_SOURCE,
  PromptAgent,
  canonicalAgentKey,
  promptAgentBlobPath,
  ruleBlobPath,
} from '@/lib/services/agentAccess/types';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_CONTROL_ENABLED: true,
}));

vi.mock('@/config/environment', () => ({ env: mockEnv }));

vi.mock('@/lib/services/agentAccess/accessRulesStore', () => ({
  createAgentAccessBlobStorage: vi.fn(() => ({})),
  listAllRules: vi.fn(),
  readConfig: vi.fn(),
  listAllPromptAgents: vi.fn(),
}));

const mockListAllRules = vi.mocked(listAllRules);
const mockReadConfig = vi.mocked(readConfig);
const mockListAllPromptAgents = vi.mocked(listAllPromptAgents);

const SOURCE_A = '/subscriptions/sub/projects/project-a';
const SOURCE_B = '/subscriptions/sub/projects/project-b';

function storedRule(
  source: string,
  agentName: string,
  access: Partial<AgentAccessRule['access']> & { type: AgentAccessType },
): StoredAgentAccessRule {
  const rule: AgentAccessRule = {
    version: 1,
    source,
    agentName,
    access: {
      allowDomains: [],
      allowUsers: [],
      allowGroups: [],
      ...access,
    },
    updatedBy: 'admin@example.com',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
  const canonicalKey = canonicalAgentKey(source, agentName);
  return {
    canonicalKey,
    blobPath: ruleBlobPath(canonicalKey),
    rule,
    etag: '"etag-1"',
  };
}

function storedPromptAgent(id: string, name = 'Helper'): StoredPromptAgent {
  const agent: PromptAgent = {
    version: 1,
    id,
    name,
    description: '',
    systemPrompt: 'You are a helper.',
    modelId: 'gpt-5.2-chat',
    createdBy: 'admin@example.com',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedBy: 'admin@example.com',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
  return {
    canonicalKey: canonicalAgentKey(PROMPT_AGENT_SOURCE, id),
    blobPath: promptAgentBlobPath(id),
    agent,
    etag: '"etag-pa"',
  };
}

function getService(): AgentAccessService {
  return AgentAccessService.getInstance();
}

async function freshServiceWith(
  rules: StoredAgentAccessRule[],
): Promise<AgentAccessService> {
  mockListAllRules.mockResolvedValue(rules);
  const service = getService();
  await service.ensureFresh();
  return service;
}

describe('AgentAccessService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the per-process singleton so each test starts cold.
    (
      AgentAccessService as unknown as { instance: AgentAccessService | null }
    ).instance = null;
    mockEnv.AGENT_ACCESS_CONTROL_ENABLED = true;
    mockListAllRules.mockResolvedValue([]);
    mockReadConfig.mockResolvedValue(null);
    mockListAllPromptAgents.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('feature disabled', () => {
    it('allows with feature-disabled and never touches storage', async () => {
      mockEnv.AGENT_ACCESS_CONTROL_ENABLED = false;
      const service = getService();
      await service.ensureFresh();

      expect(
        service.evaluateAccess({
          userMail: undefined,
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'allow', reason: 'feature-disabled' });
      expect(service.isEnabled()).toBe(false);
      expect(mockListAllRules).not.toHaveBeenCalled();
    });
  });

  describe('resolved-source evaluation', () => {
    it('allows when no rule exists for the canonical key (deny-list semantics)', async () => {
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'other-agent', { type: 'restricted' }),
      ]);

      expect(
        service.evaluateAccess({
          userMail: 'user@example.com',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'allow', reason: 'no-rule' });
    });

    it('allows a public rule regardless of user mail', async () => {
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', { type: 'public' }),
      ]);

      expect(
        service.evaluateAccess({
          userMail: undefined,
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'allow', reason: 'public' });
    });

    it('allows restricted when allowUsers matches case-insensitively', async () => {
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', {
          type: 'restricted',
          allowUsers: ['User@Example.com'],
        }),
      ]);

      expect(
        service.evaluateAccess({
          userMail: ' USER@example.COM ',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'allow', reason: 'allow-user' });
    });

    it('allows restricted when the mail domain matches allowDomains', async () => {
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', {
          type: 'restricted',
          allowDomains: ['Example.com'],
        }),
      ]);

      expect(
        service.evaluateAccess({
          userMail: 'someone@EXAMPLE.com',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'allow', reason: 'allow-domain' });
    });

    it('denies restricted when neither users nor domains match', async () => {
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', {
          type: 'restricted',
          allowUsers: ['other@example.com'],
          allowDomains: ['example.org'],
        }),
      ]);

      expect(
        service.evaluateAccess({
          userMail: 'user@example.com',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'deny', reason: 'not-allowed' });
    });

    it('denies restricted when the session has no mail, but still allows unruled agents', async () => {
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', {
          type: 'restricted',
          allowDomains: ['example.com'],
        }),
      ]);

      expect(
        service.evaluateAccess({
          userMail: undefined,
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'deny', reason: 'no-user-mail' });
      expect(
        service.evaluateAccess({
          userMail: undefined,
          source: SOURCE_A,
          agentName: 'unruled-agent',
        }),
      ).toEqual({ decision: 'allow', reason: 'no-rule' });
    });

    it('matches source and agentName case-insensitively (case-variant bypass)', async () => {
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', {
          type: 'restricted',
          allowUsers: ['other@example.com'],
        }),
      ]);

      expect(
        service.evaluateAccess({
          userMail: 'user@example.com',
          source: ` ${SOURCE_A.toUpperCase()} `,
          agentName: 'FINANCE-BOT',
        }),
      ).toEqual({ decision: 'deny', reason: 'not-allowed' });
    });
  });

  describe('unresolved-source evaluation (spec semantics #4)', () => {
    const rules = [
      storedRule(SOURCE_A, 'finance-bot', {
        type: 'restricted',
        allowUsers: ['user@example.com'],
      }),
      storedRule(SOURCE_B, 'finance-bot', {
        type: 'restricted',
        allowDomains: ['example.com'],
      }),
    ];

    it.each([null, undefined, '', '   '])(
      'treats source %j as unresolved',
      async (source) => {
        const service = await freshServiceWith(rules);

        expect(
          service.evaluateAccess({
            userMail: 'stranger@other.org',
            source,
            agentName: 'finance-bot',
          }),
        ).toEqual({
          decision: 'deny',
          reason: 'unresolved-source:not-allowed',
        });
      },
    );

    it('allows only when EVERY rule for that agentName is satisfied', async () => {
      const service = await freshServiceWith(rules);

      expect(
        service.evaluateAccess({
          userMail: 'user@example.com', // satisfies both rules
          source: null,
          agentName: 'finance-bot',
        }),
      ).toEqual({
        decision: 'allow',
        reason: 'unresolved-source-all-rules-satisfied',
      });
    });

    it('denies when only one of several rules is satisfied', async () => {
      const service = await freshServiceWith(rules);

      expect(
        service.evaluateAccess({
          // In example.com's domain (rule B) but not in rule A's allowUsers.
          userMail: 'colleague@example.com',
          source: null,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'deny', reason: 'unresolved-source:not-allowed' });
    });

    it('allows a single matching rule when satisfied', async () => {
      const service = await freshServiceWith([rules[0]]);

      expect(
        service.evaluateAccess({
          userMail: 'user@example.com',
          source: null,
          agentName: 'finance-bot',
        }),
      ).toEqual({
        decision: 'allow',
        reason: 'unresolved-source-all-rules-satisfied',
      });
    });

    it('allows when no rule matches the agentName under any source', async () => {
      const service = await freshServiceWith(rules);

      expect(
        service.evaluateAccess({
          userMail: 'stranger@other.org',
          source: null,
          agentName: 'unruled-agent',
        }),
      ).toEqual({ decision: 'allow', reason: 'no-rule' });
    });
  });

  describe('availability & caching', () => {
    it('returns unavailable when evaluate runs before any successful load', () => {
      const service = getService();

      expect(
        service.evaluateAccess({
          userMail: 'user@example.com',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'unavailable', reason: 'rules-unavailable' });
    });

    it('returns unavailable after a cold-start refresh failure (never throws)', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockListAllRules.mockRejectedValue(new Error('storage outage'));
      const service = getService();

      await expect(service.ensureFresh()).resolves.toBeUndefined();

      expect(
        service.evaluateAccess({
          userMail: 'user@example.com',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'unavailable', reason: 'rules-unavailable' });
      expect(service.getSnapshot().rulesUnavailable).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('NO last-known-good'),
      );
    });

    it('serves the last-known-good ruleset after a failed refresh', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', {
          type: 'restricted',
          allowUsers: ['user@example.com'],
        }),
      ]);

      mockListAllRules.mockRejectedValue(new Error('storage outage'));
      service.invalidate();
      await service.ensureFresh();

      // Old rules still apply — no degradation to 'unavailable'.
      expect(
        service.evaluateAccess({
          userMail: 'user@example.com',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'allow', reason: 'allow-user' });
      expect(
        service.evaluateAccess({
          userMail: 'stranger@other.org',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'deny', reason: 'not-allowed' });
      expect(service.getSnapshot().rulesUnavailable).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('serving last-known-good'),
      );
    });

    it('skips refetch inside the 60s TTL and refetches after it expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
      const service = await freshServiceWith([]);
      expect(mockListAllRules).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(59_000);
      await service.ensureFresh();
      expect(mockListAllRules).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000); // past the 60s TTL
      await service.ensureFresh();
      expect(mockListAllRules).toHaveBeenCalledTimes(2);
    });

    it('invalidate() forces a refetch on the next ensureFresh', async () => {
      const service = await freshServiceWith([]);
      expect(mockListAllRules).toHaveBeenCalledTimes(1);

      await service.ensureFresh();
      expect(mockListAllRules).toHaveBeenCalledTimes(1);

      service.invalidate();
      await service.ensureFresh();
      expect(mockListAllRules).toHaveBeenCalledTimes(2);
    });

    it('refetches after an invalidate() that lands during an in-flight refresh', async () => {
      // Regression: without the epoch guard, the completing refresh stamped
      // a fresh fetchedAt over pre-write data, so the replica that just
      // served an admin write kept serving stale rules for a full TTL.
      let resolveList: (rules: StoredAgentAccessRule[]) => void = () => {};
      mockListAllRules.mockImplementationOnce(
        () =>
          new Promise<StoredAgentAccessRule[]>((resolve) => {
            resolveList = resolve;
          }),
      );
      const service = getService();

      const inFlight = service.ensureFresh();
      // Admin write on this replica while the refresh is still in flight.
      service.invalidate();
      resolveList([storedRule(SOURCE_A, 'finance-bot', { type: 'public' })]);
      await inFlight;
      expect(mockListAllRules).toHaveBeenCalledTimes(1);

      // The fetched state is kept (never older than what it replaced) …
      expect(
        service.evaluateAccess({
          userMail: undefined,
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'allow', reason: 'public' });

      // … but it is NOT considered fresh: the next ensureFresh refetches.
      await service.ensureFresh();
      expect(mockListAllRules).toHaveBeenCalledTimes(2);
    });

    it('a refresh completing with no mid-flight invalidate stamps freshness normally', async () => {
      const service = await freshServiceWith([]);
      expect(mockListAllRules).toHaveBeenCalledTimes(1);

      await service.ensureFresh();
      expect(mockListAllRules).toHaveBeenCalledTimes(1);
    });

    it('serves last-known-good without hitting storage for 5s after a failed refresh', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', {
          type: 'restricted',
          allowUsers: ['user@example.com'],
        }),
      ]);
      expect(mockListAllRules).toHaveBeenCalledTimes(1);

      mockListAllRules.mockRejectedValue(new Error('storage outage'));
      vi.advanceTimersByTime(61_000); // past the TTL
      await service.ensureFresh(); // fails → cooldown starts
      expect(mockListAllRules).toHaveBeenCalledTimes(2);

      // Inside the 5s cooldown: no storage retry, LKG still serves.
      vi.advanceTimersByTime(4_000);
      await service.ensureFresh();
      expect(mockListAllRules).toHaveBeenCalledTimes(2);
      expect(
        service.evaluateAccess({
          userMail: 'user@example.com',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'allow', reason: 'allow-user' });

      // Past the cooldown: storage is retried again.
      vi.advanceTimersByTime(1_500);
      await service.ensureFresh();
      expect(mockListAllRules).toHaveBeenCalledTimes(3);
    });

    it('cold start (no last-known-good) keeps retrying eagerly with no cooldown', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockListAllRules.mockRejectedValue(new Error('storage outage'));
      const service = getService();

      await service.ensureFresh();
      await service.ensureFresh(); // immediately after — still retries
      expect(mockListAllRules).toHaveBeenCalledTimes(2);
    });

    it('a successful refresh clears the failure cooldown', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const service = await freshServiceWith([]);

      mockListAllRules.mockRejectedValueOnce(new Error('storage outage'));
      vi.advanceTimersByTime(61_000);
      await service.ensureFresh(); // fails
      vi.advanceTimersByTime(6_000); // cooldown over
      await service.ensureFresh(); // succeeds → cooldown cleared
      expect(mockListAllRules).toHaveBeenCalledTimes(3);

      vi.advanceTimersByTime(61_000);
      await service.ensureFresh(); // plain TTL refetch, not blocked
      expect(mockListAllRules).toHaveBeenCalledTimes(4);
    });

    it('invalidate() clears the failure cooldown so the writing replica refetches immediately', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const service = await freshServiceWith([]);

      mockListAllRules.mockRejectedValueOnce(new Error('storage outage'));
      vi.advanceTimersByTime(61_000);
      await service.ensureFresh(); // fails → cooldown starts
      expect(mockListAllRules).toHaveBeenCalledTimes(2);

      // An admin write just reached storage — retry immediately.
      service.invalidate();
      await service.ensureFresh();
      expect(mockListAllRules).toHaveBeenCalledTimes(3);
    });

    it('single-flights concurrent refreshes', async () => {
      let resolveList: (rules: StoredAgentAccessRule[]) => void = () => {};
      mockListAllRules.mockImplementation(
        () =>
          new Promise<StoredAgentAccessRule[]>((resolve) => {
            resolveList = resolve;
          }),
      );
      const service = getService();

      const first = service.ensureFresh();
      const second = service.ensureFresh();
      resolveList([]);
      await Promise.all([first, second]);

      expect(mockListAllRules).toHaveBeenCalledTimes(1);
    });

    it('getSnapshot exposes rules, config, and etag from the last load', async () => {
      const stored = storedRule(SOURCE_A, 'finance-bot', { type: 'public' });
      const config = {
        version: 1 as const,
        localAdmins: [],
        updatedBy: 'admin@example.com',
        updatedAt: '2026-07-17T00:00:00.000Z',
      };
      mockReadConfig.mockResolvedValue({ config, etag: '"cfg-etag"' });
      const service = await freshServiceWith([stored]);

      const snapshot = service.getSnapshot();
      expect(snapshot.rules).toEqual([stored]);
      expect(snapshot.config).toEqual(config);
      expect(snapshot.configEtag).toBe('"cfg-etag"');
      expect(snapshot.rulesUnavailable).toBe(false);
      expect(snapshot.fetchedAt).not.toBeNull();
    });
  });

  describe('prompt agents', () => {
    it('exposes loaded prompt agents via getPromptAgents, getPromptAgentById, and the snapshot', async () => {
      const storedA = storedPromptAgent('prompt-aaa111', 'Finance Helper');
      const storedB = storedPromptAgent('prompt-bbb222', 'HR Helper');
      mockListAllPromptAgents.mockResolvedValue([storedA, storedB]);
      const service = getService();
      await service.ensureFresh();

      expect(service.getPromptAgents()).toEqual([storedA.agent, storedB.agent]);
      expect(service.getPromptAgentById('prompt-aaa111')).toEqual(
        storedA.agent,
      );
      expect(service.getPromptAgentById('prompt-unknown')).toBeNull();
      expect(service.getSnapshot().promptAgents).toEqual([
        storedA.agent,
        storedB.agent,
      ]);
    });

    it('returns empty/null when the feature is off and never touches storage', async () => {
      mockEnv.AGENT_ACCESS_CONTROL_ENABLED = false;
      const service = getService();
      await service.ensureFresh();

      expect(service.getPromptAgents()).toEqual([]);
      expect(service.getPromptAgentById('prompt-aaa111')).toBeNull();
      expect(service.getSnapshot().promptAgents).toEqual([]);
      expect(mockListAllPromptAgents).not.toHaveBeenCalled();
    });

    it('keeps the whole last-known-good snapshot when only the prompt-agents listing fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const stored = storedPromptAgent('prompt-aaa111');
      mockListAllPromptAgents.mockResolvedValue([stored]);
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', {
          type: 'restricted',
          allowUsers: ['user@example.com'],
        }),
      ]);

      mockListAllPromptAgents.mockRejectedValue(new Error('storage outage'));
      service.invalidate();
      await service.ensureFresh();

      // Atomic refresh: BOTH halves keep serving last-known-good.
      expect(service.getPromptAgents()).toEqual([stored.agent]);
      expect(
        service.evaluateAccess({
          userMail: 'user@example.com',
          source: SOURCE_A,
          agentName: 'finance-bot',
        }),
      ).toEqual({ decision: 'allow', reason: 'allow-user' });
      expect(service.getSnapshot().rulesUnavailable).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('serving last-known-good'),
      );
    });

    it('keeps last-known-good prompt agents when only the rules listing fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const stored = storedPromptAgent('prompt-aaa111');
      mockListAllPromptAgents.mockResolvedValue([stored]);
      const service = await freshServiceWith([]);
      expect(service.getPromptAgents()).toEqual([stored.agent]);

      mockListAllRules.mockRejectedValue(new Error('storage outage'));
      mockListAllPromptAgents.mockResolvedValue([]);
      service.invalidate();
      await service.ensureFresh();

      expect(service.getPromptAgents()).toEqual([stored.agent]);
    });

    it('has no prompt agents after a cold-start refresh failure (fail closed with the rules)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mockListAllPromptAgents.mockRejectedValue(new Error('storage outage'));
      const service = getService();
      await service.ensureFresh();

      expect(service.getPromptAgents()).toEqual([]);
      expect(service.getSnapshot().rulesUnavailable).toBe(true);
    });

    it('refetches prompt agents on the shared 60s TTL cycle', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
      mockListAllPromptAgents.mockResolvedValue([
        storedPromptAgent('prompt-aaa111'),
      ]);
      const service = await freshServiceWith([]);
      expect(mockListAllPromptAgents).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(59_000);
      await service.ensureFresh();
      expect(mockListAllPromptAgents).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2_000); // past the 60s TTL
      mockListAllPromptAgents.mockResolvedValue([]);
      await service.ensureFresh();
      expect(mockListAllPromptAgents).toHaveBeenCalledTimes(2);
      expect(service.getPromptAgents()).toEqual([]);
    });

    it('invalidate() after an admin write forces a prompt-agents refetch', async () => {
      const service = await freshServiceWith([]);
      expect(mockListAllPromptAgents).toHaveBeenCalledTimes(1);

      const stored = storedPromptAgent('prompt-aaa111');
      mockListAllPromptAgents.mockResolvedValue([stored]);
      service.invalidate();
      await service.ensureFresh();

      expect(mockListAllPromptAgents).toHaveBeenCalledTimes(2);
      expect(service.getPromptAgentById('prompt-aaa111')).toEqual(stored.agent);
    });
  });

  describe('allowGroups scaffold', () => {
    it('grants nothing and warns once per rule', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const service = await freshServiceWith([
        storedRule(SOURCE_A, 'finance-bot', {
          type: 'restricted',
          allowGroups: ['engineering-group-id'],
        }),
      ]);
      const input = {
        userMail: 'user@example.com',
        source: SOURCE_A,
        agentName: 'finance-bot',
      };

      // Groups are persisted but never evaluated in v1 — no grant.
      expect(service.evaluateAccess(input)).toEqual({
        decision: 'deny',
        reason: 'not-allowed',
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('allowGroups'),
      );

      // Warning is deduped per canonical key.
      service.evaluateAccess(input);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('emitAccessAudit', () => {
    it('logs a structured audit line with all fields', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      emitAccessAudit({
        userMail: 'user@example.com',
        agentName: 'finance-bot',
        source: SOURCE_A,
        decision: 'deny',
        reason: 'not-allowed',
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const line = logSpy.mock.calls[0][0] as string;
      expect(line).toContain('[agent-access-audit]');
      expect(line).toContain('decision=deny');
      expect(line).toContain('reason=not-allowed');
      expect(line).toContain('user=user@example.com');
      expect(line).toContain('agent=finance-bot');
      expect(line).toContain(`source=${SOURCE_A}`);
    });

    it('renders placeholders for missing mail and unresolved source', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      emitAccessAudit({
        userMail: undefined,
        agentName: 'finance-bot',
        source: null,
        decision: 'unavailable',
        reason: 'rules-unavailable',
      });

      const line = logSpy.mock.calls[0][0] as string;
      expect(line).toContain('user=<none>');
      expect(line).toContain('source=<unresolved>');
    });
  });
});

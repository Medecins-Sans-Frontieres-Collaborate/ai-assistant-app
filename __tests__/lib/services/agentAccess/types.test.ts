import {
  AGENT_ACCESS_CONFIG_PATH,
  AGENT_ACCESS_HISTORY_PREFIX,
  AGENT_ACCESS_RULES_PREFIX,
  AgentAccessConfigSchema,
  AgentAccessHistoryEntrySchema,
  AgentAccessRuleSchema,
  AgentAccessTypeSchema,
  LocalAdminEntrySchema,
  canonicalAgentKey,
  historyBlobPath,
  ruleBlobPath,
} from '@/lib/services/agentAccess/types';

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';

const SOURCE =
  '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.CognitiveServices/accounts/acct/projects/proj';

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

const validRuleInput = {
  version: 1,
  source: SOURCE,
  agentName: 'finance-bot',
  access: {
    type: 'restricted',
    allowDomains: ['example.com'],
    allowUsers: ['a@example.com'],
    allowGroups: [],
  },
  updatedBy: 'admin@example.com',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

describe('agentAccess/types', () => {
  describe('canonicalAgentKey', () => {
    it('joins lowercased + trimmed halves with ::', () => {
      expect(canonicalAgentKey('  /Sub/A/Projects/X ', ' Finance-Bot ')).toBe(
        '/sub/a/projects/x::finance-bot',
      );
    });

    it('makes case-variant inputs collide (case-variant bypass prevention)', () => {
      expect(canonicalAgentKey(SOURCE.toUpperCase(), 'FINANCE-BOT')).toBe(
        canonicalAgentKey(SOURCE, 'finance-bot'),
      );
    });

    it('does not collide across different keys', () => {
      expect(canonicalAgentKey(SOURCE, 'agent-a')).not.toBe(
        canonicalAgentKey(SOURCE, 'agent-b'),
      );
    });
  });

  describe('blob path builders', () => {
    it('ruleBlobPath hashes the canonical key under the rules prefix', () => {
      const key = canonicalAgentKey(SOURCE, 'finance-bot');
      expect(ruleBlobPath(key)).toBe(
        `${AGENT_ACCESS_RULES_PREFIX}${sha256(key)}.json`,
      );
    });

    it('historyBlobPath nests the timestamp under the hashed key', () => {
      const key = canonicalAgentKey(SOURCE, 'finance-bot');
      const ts = '2026-07-17T00:00:00.000Z';
      expect(historyBlobPath(key, ts)).toBe(
        `${AGENT_ACCESS_HISTORY_PREFIX}${sha256(key)}/${ts}.json`,
      );
    });

    it('reserved prefixes cannot collide with user upload paths', () => {
      expect(AGENT_ACCESS_CONFIG_PATH).toBe('system/agent-access/config.json');
      expect(AGENT_ACCESS_RULES_PREFIX).toBe('system/agent-access/rules/');
      expect(AGENT_ACCESS_HISTORY_PREFIX).toBe('system/agent-access/history/');
    });
  });

  describe('AgentAccessTypeSchema', () => {
    it.each(['public', 'restricted'])('accepts %j', (value) => {
      expect(AgentAccessTypeSchema.parse(value)).toBe(value);
    });

    it.each(['Public', 'open', '', null])('rejects %j', (value) => {
      expect(AgentAccessTypeSchema.safeParse(value).success).toBe(false);
    });
  });

  describe('AgentAccessRuleSchema', () => {
    it('accepts a fully-specified rule', () => {
      expect(AgentAccessRuleSchema.parse(validRuleInput)).toEqual(
        validRuleInput,
      );
    });

    it('defaults omitted allow lists to empty arrays', () => {
      const parsed = AgentAccessRuleSchema.parse({
        ...validRuleInput,
        access: { type: 'public' },
      });
      expect(parsed.access).toEqual({
        type: 'public',
        allowDomains: [],
        allowUsers: [],
        allowGroups: [],
      });
    });

    it.each([
      ['wrong version', { ...validRuleInput, version: 2 }],
      ['empty source', { ...validRuleInput, source: '' }],
      ['empty agentName', { ...validRuleInput, agentName: '' }],
      ['missing access', { ...validRuleInput, access: undefined }],
      [
        'invalid access type',
        { ...validRuleInput, access: { ...validRuleInput.access, type: 'x' } },
      ],
      ['missing updatedBy', { ...validRuleInput, updatedBy: undefined }],
      ['missing updatedAt', { ...validRuleInput, updatedAt: undefined }],
    ])('rejects %s', (_label, input) => {
      expect(AgentAccessRuleSchema.safeParse(input).success).toBe(false);
    });
  });

  describe('LocalAdminEntrySchema', () => {
    it('defaults agentKeys to an empty array', () => {
      expect(LocalAdminEntrySchema.parse({ email: 'a@b.com' })).toEqual({
        email: 'a@b.com',
        agentKeys: [],
      });
    });

    it('rejects an empty email', () => {
      expect(LocalAdminEntrySchema.safeParse({ email: '' }).success).toBe(
        false,
      );
    });
  });

  describe('AgentAccessConfigSchema', () => {
    it('accepts a config and defaults localAdmins', () => {
      expect(
        AgentAccessConfigSchema.parse({
          version: 1,
          updatedBy: 'admin@example.com',
          updatedAt: '2026-07-17T00:00:00.000Z',
        }),
      ).toEqual({
        version: 1,
        localAdmins: [],
        updatedBy: 'admin@example.com',
        updatedAt: '2026-07-17T00:00:00.000Z',
      });
    });

    it('rejects malformed localAdmins entries', () => {
      expect(
        AgentAccessConfigSchema.safeParse({
          version: 1,
          localAdmins: [{ agentKeys: ['k'] }], // missing email
          updatedBy: 'admin@example.com',
          updatedAt: '2026-07-17T00:00:00.000Z',
        }).success,
      ).toBe(false);
    });
  });

  describe('AgentAccessHistoryEntrySchema', () => {
    const base = {
      version: 1,
      canonicalKey: canonicalAgentKey(SOURCE, 'finance-bot'),
      updatedBy: 'admin@example.com',
      updatedAt: '2026-07-17T00:00:00.000Z',
    };

    it('accepts an upsert entry carrying the full rule', () => {
      const parsed = AgentAccessHistoryEntrySchema.parse({
        ...base,
        action: 'upsert',
        rule: validRuleInput,
      });
      expect(parsed.rule).toEqual(validRuleInput);
    });

    it('accepts a delete tombstone with a null rule', () => {
      const parsed = AgentAccessHistoryEntrySchema.parse({
        ...base,
        action: 'delete',
        rule: null,
      });
      expect(parsed.rule).toBeNull();
    });

    it.each([
      ['unknown action', { ...base, action: 'rename', rule: null }],
      [
        'empty canonicalKey',
        { ...base, canonicalKey: '', action: 'delete', rule: null },
      ],
      ['missing rule field', { ...base, action: 'upsert' }],
    ])('rejects %s', (_label, input) => {
      expect(AgentAccessHistoryEntrySchema.safeParse(input).success).toBe(
        false,
      );
    });
  });
});

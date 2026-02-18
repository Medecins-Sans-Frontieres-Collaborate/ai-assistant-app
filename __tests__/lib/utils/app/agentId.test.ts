import { isLegacyAgentId, isValidAgentId } from '@/lib/utils/app/agentId';

import { describe, expect, it } from 'vitest';

describe('agentId utilities', () => {
  describe('isLegacyAgentId', () => {
    it('returns true for valid legacy agent IDs', () => {
      expect(isLegacyAgentId('asst_abc123')).toBe(true);
      expect(isLegacyAgentId('asst_test_agent_123')).toBe(true);
      expect(isLegacyAgentId('asst_test-agent-123')).toBe(true);
      expect(isLegacyAgentId('asst_TestAgent123')).toBe(true);
      expect(isLegacyAgentId('asst_sbddkxz8DLyCXATINdB10pys')).toBe(true);
    });

    it('returns false for new-format agent names', () => {
      expect(isLegacyAgentId('my-agent')).toBe(false);
      expect(isLegacyAgentId('gpt-41')).toBe(false);
      expect(isLegacyAgentId('claude-sonnet-46')).toBe(false);
    });

    it('returns false for invalid IDs', () => {
      expect(isLegacyAgentId('')).toBe(false);
      expect(isLegacyAgentId('asst_')).toBe(false);
      expect(isLegacyAgentId('agent_abc')).toBe(false);
      expect(isLegacyAgentId('asst_abc@123')).toBe(false);
    });
  });

  describe('isValidAgentId', () => {
    it('accepts legacy asst_ format', () => {
      expect(isValidAgentId('asst_abc123')).toBe(true);
      expect(isValidAgentId('asst_test_agent_123')).toBe(true);
      expect(isValidAgentId('asst_test-agent-123')).toBe(true);
    });

    it('accepts new agent name format', () => {
      expect(isValidAgentId('my-agent')).toBe(true);
      expect(isValidAgentId('gpt-41')).toBe(true);
      expect(isValidAgentId('claude-sonnet-46')).toBe(true);
      expect(isValidAgentId('agent123')).toBe(true);
      expect(isValidAgentId('MyAgent')).toBe(true);
      expect(isValidAgentId('a')).toBe(true);
      expect(isValidAgentId('agent_with_underscores')).toBe(true);
    });

    it('rejects invalid IDs', () => {
      expect(isValidAgentId('')).toBe(false);
      expect(isValidAgentId('-starts-with-hyphen')).toBe(false);
      expect(isValidAgentId('_starts-with-underscore')).toBe(false);
      expect(isValidAgentId('has spaces')).toBe(false);
      expect(isValidAgentId('has@special')).toBe(false);
      expect(isValidAgentId('has.dots')).toBe(false);
    });
  });
});

import {
  ALL_AGENT_KEYS,
  isGlobalAdmin,
  parseGlobalAdminEmails,
  resolveAdminStatus,
} from '@/lib/services/agentAccess/adminAuth';
import {
  AgentAccessConfig,
  canonicalAgentKey,
} from '@/lib/services/agentAccess/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  AGENT_ACCESS_ADMINS: undefined as string | undefined,
}));

vi.mock('@/config/environment', () => ({ env: mockEnv }));

const KEY_A = canonicalAgentKey('/subscriptions/sub/projects/a', 'finance-bot');
const KEY_B = canonicalAgentKey('/subscriptions/sub/projects/b', 'hr-bot');

function configWith(
  localAdmins: AgentAccessConfig['localAdmins'],
): AgentAccessConfig {
  return {
    version: 1,
    localAdmins,
    updatedBy: 'admin@example.com',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

describe('agentAccess/adminAuth', () => {
  beforeEach(() => {
    mockEnv.AGENT_ACCESS_ADMINS = undefined;
  });

  describe('parseGlobalAdminEmails', () => {
    it('splits on commas, trims, lowercases, and drops empties', () => {
      expect(
        parseGlobalAdminEmails('  Admin@Example.COM , b@x.org ,, , c@Y.io  '),
      ).toEqual(['admin@example.com', 'b@x.org', 'c@y.io']);
    });

    it.each([undefined, '', '  , ,'])('returns [] for raw value %j', (raw) => {
      expect(parseGlobalAdminEmails(raw)).toEqual([]);
    });

    it('defaults to env.AGENT_ACCESS_ADMINS when called without arguments', () => {
      mockEnv.AGENT_ACCESS_ADMINS = ' One@Example.com,two@example.com ';
      expect(parseGlobalAdminEmails()).toEqual([
        'one@example.com',
        'two@example.com',
      ]);
    });
  });

  describe('isGlobalAdmin', () => {
    beforeEach(() => {
      mockEnv.AGENT_ACCESS_ADMINS = 'Admin@Example.com';
    });

    it('matches lowercased + trimmed against the env list', () => {
      expect(isGlobalAdmin('  ADMIN@example.COM ')).toBe(true);
      expect(isGlobalAdmin('admin@example.com')).toBe(true);
      expect(isGlobalAdmin('other@example.com')).toBe(false);
    });

    it.each([null, undefined, ''])('returns false for mail %j', (mail) => {
      expect(isGlobalAdmin(mail)).toBe(false);
    });

    it('returns false for everyone when the env var is unset', () => {
      mockEnv.AGENT_ACCESS_ADMINS = undefined;
      expect(isGlobalAdmin('admin@example.com')).toBe(false);
    });
  });

  describe('resolveAdminStatus', () => {
    it('gives global admins the ALL_AGENT_KEYS sentinel, not local-admin status', () => {
      mockEnv.AGENT_ACCESS_ADMINS = 'admin@example.com';

      expect(
        resolveAdminStatus(
          'Admin@Example.com',
          configWith([{ email: 'admin@example.com', agentKeys: [KEY_A] }]),
        ),
      ).toEqual({
        isGlobalAdmin: true,
        isLocalAdmin: false,
        editableAgentKeys: ALL_AGENT_KEYS,
      });
    });

    it('matches local admin emails canonicalized (trim + lowercase)', () => {
      const status = resolveAdminStatus(
        '  LEAD@Example.COM ',
        configWith([{ email: ' Lead@example.com ', agentKeys: [KEY_A] }]),
      );

      expect(status).toEqual({
        isGlobalAdmin: false,
        isLocalAdmin: true,
        editableAgentKeys: [KEY_A],
      });
    });

    it('unions delegated keys across multiple matching entries without duplicates', () => {
      const status = resolveAdminStatus(
        'lead@example.com',
        configWith([
          { email: 'lead@example.com', agentKeys: [KEY_A, KEY_B] },
          { email: 'Lead@Example.com', agentKeys: [KEY_A] },
          { email: 'someone-else@example.com', agentKeys: ['other-key'] },
        ]),
      );

      expect(status.isLocalAdmin).toBe(true);
      expect([...status.editableAgentKeys].sort()).toEqual(
        [KEY_A, KEY_B].sort(),
      );
    });

    it('canonicalizes delegated agent keys (trim + lowercase) in editableAgentKeys', () => {
      // Regression: case/whitespace variants hand-typed into config.json used
      // to pass through verbatim; the client-side delegated-key filter then
      // failed to match them against canonical keys even though server-side
      // canEditKey tolerated the variants.
      const status = resolveAdminStatus(
        'lead@example.com',
        configWith([
          {
            email: 'lead@example.com',
            agentKeys: [`  ${KEY_A.toUpperCase()}  `, KEY_B],
          },
        ]),
      );

      expect(status.isLocalAdmin).toBe(true);
      expect([...status.editableAgentKeys].sort()).toEqual(
        [KEY_A, KEY_B].sort(),
      );
    });

    it('dedupes case/whitespace variants of the same delegated key', () => {
      const status = resolveAdminStatus(
        'lead@example.com',
        configWith([
          { email: 'lead@example.com', agentKeys: [KEY_A] },
          {
            email: 'Lead@Example.com',
            agentKeys: [` ${KEY_A.toUpperCase()} `],
          },
        ]),
      );

      expect(status.editableAgentKeys).toEqual([KEY_A]);
    });

    it('returns non-admin status for unmatched users', () => {
      expect(
        resolveAdminStatus(
          'user@example.com',
          configWith([{ email: 'lead@example.com', agentKeys: [KEY_A] }]),
        ),
      ).toEqual({
        isGlobalAdmin: false,
        isLocalAdmin: false,
        editableAgentKeys: [],
      });
    });

    it('a matching entry with no delegated keys still confers local-admin status', () => {
      // Agent-less local admins: membership alone makes isLocalAdmin true
      // (they can create prompt agents); the empty key list still edits
      // nothing (canEditKey over [] denies every existing key).
      expect(
        resolveAdminStatus(
          'lead@example.com',
          configWith([{ email: 'lead@example.com', agentKeys: [] }]),
        ),
      ).toEqual({
        isGlobalAdmin: false,
        isLocalAdmin: true,
        editableAgentKeys: [],
      });
    });

    it('matches zero-key entries canonicalized (trim + lowercase)', () => {
      const status = resolveAdminStatus(
        ' LEAD@Example.COM ',
        configWith([{ email: ' Lead@example.com ', agentKeys: [] }]),
      );

      expect(status).toEqual({
        isGlobalAdmin: false,
        isLocalAdmin: true,
        editableAgentKeys: [],
      });
    });

    it.each([null, undefined, ''])(
      'returns non-admin status for mail %j',
      (mail) => {
        expect(
          resolveAdminStatus(
            mail,
            configWith([{ email: 'lead@example.com', agentKeys: [KEY_A] }]),
          ),
        ).toEqual({
          isGlobalAdmin: false,
          isLocalAdmin: false,
          editableAgentKeys: [],
        });
      },
    );

    it('returns non-admin status when no config exists yet', () => {
      expect(resolveAdminStatus('lead@example.com', null)).toEqual({
        isGlobalAdmin: false,
        isLocalAdmin: false,
        editableAgentKeys: [],
      });
    });
  });
});

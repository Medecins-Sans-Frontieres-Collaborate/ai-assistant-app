import {
  ToolApprovalRule,
  evaluateToolApprovalRules,
} from '@/lib/utils/shared/chat/toolApprovalRules';

import { describe, expect, it } from 'vitest';

function rule(overrides: Partial<ToolApprovalRule>): ToolApprovalRule {
  return {
    id: 'r1',
    toolName: 'create_issue',
    action: 'approve',
    createdAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('evaluateToolApprovalRules', () => {
  it('returns null when no rule matches', () => {
    expect(
      evaluateToolApprovalRules(
        [rule({ toolName: 'other_tool' })],
        'create_issue',
        'GitHub',
      ),
    ).toBeNull();
  });

  it('matches an unscoped rule against any server', () => {
    expect(
      evaluateToolApprovalRules([rule({})], 'create_issue', 'GitHub'),
    ).toBe('approve');
    expect(evaluateToolApprovalRules([rule({})], 'create_issue', null)).toBe(
      'approve',
    );
  });

  it('scoped rules match their server label case-insensitively', () => {
    const scoped = [rule({ serverLabel: 'GitHub' })];
    expect(evaluateToolApprovalRules(scoped, 'create_issue', 'github ')).toBe(
      'approve',
    );
    expect(
      evaluateToolApprovalRules(scoped, 'create_issue', 'NetSuite'),
    ).toBeNull();
    // A scoped rule cannot match a request with no label at all.
    expect(evaluateToolApprovalRules(scoped, 'create_issue', null)).toBeNull();
  });

  it('tool names match exactly (MCP identifiers are case-sensitive)', () => {
    expect(
      evaluateToolApprovalRules([rule({})], 'Create_Issue', 'GitHub'),
    ).toBeNull();
  });

  it('REJECT wins when both an approve and a reject rule match', () => {
    // "Never run this" is a safety decision; a convenience approval must
    // not override it regardless of rule order.
    const rules = [
      rule({ id: 'a', action: 'approve' }),
      rule({ id: 'b', action: 'reject', serverLabel: 'GitHub' }),
    ];
    expect(evaluateToolApprovalRules(rules, 'create_issue', 'GitHub')).toBe(
      'reject',
    );
    expect(
      evaluateToolApprovalRules(rules.reverse(), 'create_issue', 'GitHub'),
    ).toBe('reject');
  });

  it('returns null for a nameless prompt — never auto-decide blind', () => {
    expect(evaluateToolApprovalRules([rule({})], null, 'GitHub')).toBeNull();
  });
});

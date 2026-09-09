import { useSettingsStore } from '@/client/stores/settingsStore';
import { beforeEach, describe, expect, it } from 'vitest';

describe('settingsStore tool approval rules', () => {
  beforeEach(() => {
    useSettingsStore.setState({ toolApprovalRules: [] });
  });

  it('adds a rule with a generated id and timestamp', () => {
    useSettingsStore.getState().addToolApprovalRule({
      toolName: 'create_issue',
      serverLabel: 'GitHub',
      action: 'approve',
    });

    const rules = useSettingsStore.getState().toolApprovalRules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      toolName: 'create_issue',
      serverLabel: 'GitHub',
      action: 'approve',
    });
    expect(rules[0].id).toBeTruthy();
    expect(rules[0].createdAt).toBeTruthy();
  });

  it('re-adding the same tool/scope replaces the rule instead of stacking', () => {
    // Otherwise "always allow" then "never allow" would leave two
    // contradictory rules the evaluator has to referee forever.
    const store = useSettingsStore.getState();
    store.addToolApprovalRule({
      toolName: 'create_issue',
      serverLabel: 'GitHub',
      action: 'approve',
    });
    useSettingsStore.getState().addToolApprovalRule({
      toolName: 'create_issue',
      serverLabel: 'github',
      action: 'reject',
    });

    const rules = useSettingsStore.getState().toolApprovalRules;
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe('reject');
  });

  it('treats scoped and unscoped rules for the same tool as distinct', () => {
    const store = useSettingsStore.getState();
    store.addToolApprovalRule({ toolName: 'create_issue', action: 'approve' });
    useSettingsStore.getState().addToolApprovalRule({
      toolName: 'create_issue',
      serverLabel: 'GitHub',
      action: 'reject',
    });

    expect(useSettingsStore.getState().toolApprovalRules).toHaveLength(2);
  });

  describe('setToolApprovalPolicy', () => {
    it('replaces whatever applied to the tool on that server — scoped AND unscoped', () => {
      const store = useSettingsStore.getState();
      store.addToolApprovalRule({ toolName: 'get_me', action: 'reject' });
      useSettingsStore.getState().addToolApprovalRule({
        toolName: 'get_me',
        serverLabel: 'GitHub',
        action: 'reject',
      });

      useSettingsStore
        .getState()
        .setToolApprovalPolicy('get_me', 'GitHub', 'approve');

      const rules = useSettingsStore.getState().toolApprovalRules;
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({
        toolName: 'get_me',
        serverLabel: 'GitHub',
        action: 'approve',
      });
    });

    it("keeps other servers' scoped rules for the same tool name", () => {
      useSettingsStore.getState().addToolApprovalRule({
        toolName: 'create_issue',
        serverLabel: 'Jira',
        action: 'approve',
      });

      useSettingsStore
        .getState()
        .setToolApprovalPolicy('create_issue', 'GitHub', 'reject');

      const rules = useSettingsStore.getState().toolApprovalRules;
      expect(rules).toHaveLength(2);
      expect(rules.find((r) => r.serverLabel === 'Jira')?.action).toBe(
        'approve',
      );
    });

    it("'ask' clears every applicable rule and stores nothing", () => {
      useSettingsStore.getState().addToolApprovalRule({
        toolName: 'get_me',
        serverLabel: 'GitHub',
        action: 'approve',
      });

      useSettingsStore
        .getState()
        .setToolApprovalPolicy('get_me', 'github', 'ask');

      expect(useSettingsStore.getState().toolApprovalRules).toHaveLength(0);
    });
  });

  it('removes a rule by id', () => {
    useSettingsStore
      .getState()
      .addToolApprovalRule({ toolName: 'create_issue', action: 'reject' });
    const [added] = useSettingsStore.getState().toolApprovalRules;

    useSettingsStore.getState().removeToolApprovalRule(added.id);

    expect(useSettingsStore.getState().toolApprovalRules).toHaveLength(0);
  });
});

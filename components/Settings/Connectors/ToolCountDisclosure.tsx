'use client';

import { IconChevronDown } from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { evaluateToolApprovalRules } from '@/lib/utils/shared/chat/toolApprovalRules';

import { McpToolSummary } from '@/types/mcp';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * The "N tools available" text on a connector row, upgraded to a
 * disclosure: expanding it lists every tool the server just advertised
 * with a per-tool GLOBAL policy control — Ask (the default prompt), Allow
 * (auto-approve everywhere), or Block (auto-reject everywhere). The same
 * rules the consent cards and the Tool approvals section manage; setting a
 * policy here writes a rule scoped to this server's label and clears any
 * previous rule (scoped OR unscoped) that applied to the tool here, so
 * what you click is what you get.
 *
 * Rendered as a fragment: the trigger sits inline in the row's flex-wrap
 * control strip, while the list is a w-full child that wraps onto its own
 * full-width line beneath it.
 */
export const ToolCountDisclosure: FC<{
  /** Label the stream markers will echo (catalog label / connector name). */
  serverLabel: string;
  tools: McpToolSummary[];
  /**
   * Tools whose consent semantics are fixed (M365 alwaysConfirm writes):
   * rendered with a locked "Always asks" chip instead of the policy
   * selector — an Allow rule would be recorded but ignored at the card,
   * which is exactly the confusion this lock prevents.
   */
  lockedToolNames?: ReadonlySet<string>;
}> = ({ serverLabel, tools, lockedToolNames }) => {
  const t = useTranslations('connectors');
  const tPolicy = useTranslations('toolApprovals');
  const rules = useSettingsStore((s) => s.toolApprovalRules);
  const setPolicy = useSettingsStore((s) => s.setToolApprovalPolicy);
  const [open, setOpen] = useState(false);

  if (tools.length === 0) return null;

  const policies = [
    { key: 'ask', label: tPolicy('policyAsk') },
    { key: 'approve', label: tPolicy('policyAllow') },
    { key: 'reject', label: tPolicy('policyBlock') },
  ] as const;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
      >
        {t('toolCount', { count: tools.length })}
        <IconChevronDown
          size={12}
          className={`transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="w-full">
          <p className="mb-1.5 text-xs text-gray-500 dark:text-gray-400">
            {tPolicy('listHint')}
          </p>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-700">
            {tools.map((tool) => {
              const decision = evaluateToolApprovalRules(
                rules,
                tool.name,
                serverLabel,
              );
              const active = decision ?? 'ask';
              const locked = lockedToolNames?.has(tool.name) ?? false;
              return (
                <li
                  key={tool.name}
                  className="flex items-center gap-3 px-3 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <code className="block truncate font-mono text-xs text-gray-900 dark:text-gray-100">
                      {tool.name}
                    </code>
                    {tool.description && (
                      <p
                        className="truncate text-xs text-gray-500 dark:text-gray-400"
                        title={tool.description}
                      >
                        {tool.description}
                      </p>
                    )}
                  </div>
                  {locked ? (
                    <span className="shrink-0 rounded-md border border-amber-300 px-2 py-0.5 text-xs text-amber-800 dark:border-amber-700 dark:text-amber-300">
                      {tPolicy('alwaysAsks')}
                    </span>
                  ) : (
                    <div
                      className="inline-flex shrink-0 overflow-hidden rounded-md border border-gray-200 dark:border-gray-700"
                      role="group"
                      aria-label={tPolicy('policyGroupLabel', {
                        tool: tool.name,
                      })}
                    >
                      {policies.map((policy) => (
                        <button
                          key={policy.key}
                          type="button"
                          onClick={() =>
                            setPolicy(tool.name, serverLabel, policy.key)
                          }
                          aria-pressed={active === policy.key}
                          className={`px-2 py-0.5 text-xs transition-colors ${
                            active === policy.key
                              ? policy.key === 'reject'
                                ? 'bg-red-100 font-medium text-red-800 dark:bg-red-900/40 dark:text-red-300'
                                : policy.key === 'approve'
                                  ? 'bg-green-100 font-medium text-green-800 dark:bg-green-900/40 dark:text-green-300'
                                  : 'bg-gray-200 font-medium text-gray-900 dark:bg-gray-600 dark:text-gray-100'
                              : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                          }`}
                        >
                          {policy.label}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
};

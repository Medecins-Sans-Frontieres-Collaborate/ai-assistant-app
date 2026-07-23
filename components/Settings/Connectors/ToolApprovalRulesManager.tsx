'use client';

import { IconChevronDown, IconPlus, IconTrash } from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Settings manager for the GLOBAL tool approval policy: every rule
 * auto-approves or auto-rejects one named MCP tool in all conversations.
 * Free-text tool entry is deliberate — rules can be written for tools the
 * user has not encountered yet (they know from a vendor's docs what a
 * connector can do). Reject rules always beat approvals, including the
 * per-conversation "always approve" toggles set from consent cards.
 */
export const ToolApprovalRulesManager: FC = () => {
  const t = useTranslations('toolApprovals');
  const rules = useSettingsStore((s) => s.toolApprovalRules);
  const addRule = useSettingsStore((s) => s.addToolApprovalRule);
  const removeRule = useSettingsStore((s) => s.removeToolApprovalRule);
  const mcpServers = useSettingsStore((s) => s.mcpServers);

  const [toolName, setToolName] = useState('');
  const [serverLabel, setServerLabel] = useState('');
  const [action, setAction] = useState<'approve' | 'reject'>('approve');
  // Collapsed by default; expands automatically once rules exist so an
  // active policy is never hidden state.
  const [expanded, setExpanded] = useState(false);
  const isOpen = expanded || rules.length > 0;

  // Distinct configured server names for the scope dropdown; a rule saved
  // for a since-removed server keeps working via its stored label.
  const serverNames = [...new Set(mcpServers.map((s) => s.name))];

  const handleAdd = () => {
    const trimmed = toolName.trim();
    if (!trimmed) return;
    addRule({
      toolName: trimmed,
      serverLabel: serverLabel || undefined,
      action,
    });
    setToolName('');
  };

  const inputClass =
    'rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-1.5 text-sm text-black dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500';

  return (
    <div className="mt-8">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={isOpen}
        className="flex items-center gap-1.5"
      >
        <h3 className="text-base font-semibold text-black dark:text-white">
          {t('title')}
        </h3>
        <IconChevronDown
          size={16}
          className={`text-gray-500 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      <p className="mb-3 mt-1 text-sm text-gray-600 dark:text-gray-400">
        {t('description')}
      </p>

      {!isOpen ? null : (
        <>
          {rules.length > 0 && (
            <ul className="mb-4 space-y-2">
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex items-center gap-2 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2"
                >
                  <span
                    className={`flex-shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      rule.action === 'approve'
                        ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                        : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                    }`}
                  >
                    {t(
                      rule.action === 'approve'
                        ? 'actionApprove'
                        : 'actionReject',
                    )}
                  </span>
                  <code className="truncate font-mono text-sm text-gray-900 dark:text-gray-100">
                    {rule.toolName}
                  </code>
                  <span className="min-w-0 truncate text-xs text-gray-500 dark:text-gray-400">
                    {rule.serverLabel
                      ? t('scopeServer', { name: rule.serverLabel })
                      : t('scopeAny')}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeRule(rule.id)}
                    className="ml-auto flex-shrink-0 rounded-md p-1 text-gray-500 hover:bg-gray-100 hover:text-red-600 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-red-400 transition-colors"
                    aria-label={t('removeRule', { tool: rule.toolName })}
                    title={t('removeRule', { tool: rule.toolName })}
                  >
                    <IconTrash size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${inputClass} min-w-[12rem] flex-1 font-mono`}
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
              placeholder={t('toolNamePlaceholder')}
              aria-label={t('toolNameLabel')}
              spellCheck={false}
            />
            <select
              className={inputClass}
              value={serverLabel}
              onChange={(e) => setServerLabel(e.target.value)}
              aria-label={t('scopeLabel')}
            >
              <option value="">{t('scopeAny')}</option>
              {serverNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select
              className={inputClass}
              value={action}
              onChange={(e) =>
                setAction(e.target.value as 'approve' | 'reject')
              }
              aria-label={t('actionLabel')}
            >
              <option value="approve">{t('actionApprove')}</option>
              <option value="reject">{t('actionReject')}</option>
            </select>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!toolName.trim()}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-black dark:text-white hover:bg-gray-100 dark:hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <IconPlus size={14} />
              {t('addRule')}
            </button>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t('rejectPrecedenceNote')}
          </p>
        </>
      )}
    </div>
  );
};

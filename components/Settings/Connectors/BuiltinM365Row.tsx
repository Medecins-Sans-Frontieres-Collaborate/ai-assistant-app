'use client';

import { IconBrandWindows } from '@tabler/icons-react';
import { FC, useMemo } from 'react';

import { useTranslations } from 'next-intl';

import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import {
  M365_ALWAYS_CONFIRM_TOOLS,
  M365_BUILTIN_SERVER_LABEL,
  M365_TOOL_SPECS,
} from '@/lib/services/m365/tools/toolCatalog';

import type { McpToolSummary } from '@/types/mcp';

import { ToolCountDisclosure } from './ToolCountDisclosure';

import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * The builtin Microsoft 365 toolset as a first-class connector row —
 * same surface as MCP rows (global toggle, tool listing, per-tool approval
 * rules), minus the things that don't apply: no URL/auth editing, no
 * disconnect (the M365 opt-in lives in Settings → Connections). Write
 * tools render locked "Always asks" chips — their consent semantics are
 * fixed and approve rules are ignored for them by design.
 *
 * The listing shows the FULL catalog; tenant consent trims the live
 * toolset per scope at chat time (partial consent = partial toolset), and
 * the Connections panel's feature checklist is where that status shows.
 */
export const BuiltinM365Row: FC = () => {
  const t = useTranslations('m365.tools');
  const tConnectors = useTranslations('connectors');
  const { toolsEnabled } = useM365Enabled();
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const userEnabled = useSettingsStore((s) => s.m365ToolsUserEnabled);
  const setUserEnabled = useSettingsStore((s) => s.setM365ToolsUserEnabled);

  const tools: McpToolSummary[] = useMemo(
    () =>
      M365_TOOL_SPECS.map((spec) => ({
        name: spec.name,
        description: spec.description,
      })),
    [],
  );

  if (!toolsEnabled) return null;

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <IconBrandWindows
            size={24}
            className="mt-0.5 flex-shrink-0 text-blue-500"
          />
          <div className="min-w-0">
            <div className="font-medium text-gray-900 dark:text-gray-100">
              {M365_BUILTIN_SERVER_LABEL}
              <span className="ml-2 rounded-full border border-neutral-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-gray-500 dark:border-neutral-600 dark:text-gray-400">
                {t('builtinBadge')}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
              {t('trayDescription')}
            </p>
            {!m365Connected && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {t('connectFirstHint')}
              </p>
            )}
            <div className="mt-2">
              <ToolCountDisclosure
                serverLabel={M365_BUILTIN_SERVER_LABEL}
                tools={tools}
                lockedToolNames={M365_ALWAYS_CONFIRM_TOOLS}
              />
            </div>
          </div>
        </div>
        <label className="flex flex-shrink-0 cursor-pointer items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={userEnabled}
            onChange={(event) => setUserEnabled(event.target.checked)}
            aria-label={tConnectors('enabledToggle', {
              name: M365_BUILTIN_SERVER_LABEL,
            })}
          />
          {tConnectors('enabledLabel')}
        </label>
      </div>
    </div>
  );
};

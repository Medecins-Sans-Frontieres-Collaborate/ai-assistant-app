'use client';

import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronRight,
  IconSparkles,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  SkillUsageLine,
  skillUsageHasIssue,
  summarizeSkillToolCalls,
} from '@/lib/utils/shared/chat/skillToolCalls';

import type { ToolCallRecord } from '@/types/chat';

interface SkillUsageChipProps {
  /** Skill-use records only — see partitionSkillToolCalls. */
  toolCalls: ToolCallRecord[];
}

/**
 * "Skills: GDPR (auto), Platform Help (requested)" — the per-message record
 * of which skills shaped the answer and how they were selected
 * (docs/SKILLS_DESIGN.md §10). Rendered apart from the MCP tool strip so
 * skill use reads as guidance applied, not as an external tool call. The
 * chip names everything inline; the toggle reveals the raw lines (dropped
 * ids, degraded routing, document notices) for anyone debugging a turn.
 */
export const SkillUsageChip: FC<SkillUsageChipProps> = ({ toolCalls }) => {
  const t = useTranslations('chat.skillUsage');
  const [expanded, setExpanded] = useState(false);

  if (toolCalls.length === 0) return null;

  const lines = summarizeSkillToolCalls(toolCalls);
  const issue = skillUsageHasIssue(toolCalls);

  const label = (line: SkillUsageLine): string | null => {
    switch (line.kind) {
      case 'skill':
        return `${line.name} (${t(line.via)}${
          line.version ? `, ${t(line.version)}` : ''
        })`;
      case 'consent':
        return `${line.name} (${t('needsApproval')})`;
      case 'unavailable':
        return `${line.id} (${t('unavailable')})`;
      case 'references':
        return t('references', { count: line.count });
      case 'agentLoad':
        return `${line.name} (${t('agentLoad')})`;
      case 'agentSearch':
        return t('agentSearch');
      case 'note':
        return null;
    }
  };
  const inline = lines.map(label).filter((text): text is string => !!text);
  const notes = lines.filter(
    (line): line is Extract<SkillUsageLine, { kind: 'note' }> =>
      line.kind === 'note',
  );
  const hasDetails = notes.length > 0 || toolCalls.some((call) => call.error);

  return (
    <div className="my-3 max-w-prose not-prose" data-testid="skill-usage-chip">
      <div
        className={`inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
          issue
            ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200'
            : 'border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200'
        }`}
      >
        {issue ? (
          <IconAlertCircle size={12} aria-hidden="true" />
        ) : (
          <IconSparkles size={12} aria-hidden="true" />
        )}
        <span className="font-medium">{t('label')}:</span>
        <span className="min-w-0 break-words">
          {inline.length > 0 ? inline.join(', ') : t('incomplete')}
        </span>
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? t('hideDetails') : t('showDetails')}
            className="ml-1 inline-flex items-center rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
          >
            {expanded ? (
              <IconChevronDown size={12} aria-hidden="true" />
            ) : (
              <IconChevronRight size={12} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      {expanded && hasDetails && (
        <ul className="mt-2 space-y-1 border-l-2 border-gray-200 pl-3 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-300">
          {notes.map((note, index) => (
            <li key={`note-${index}`} className="break-words">
              {note.text}
            </li>
          ))}
          {toolCalls
            .filter((call) => call.error)
            .map((call) => (
              <li
                key={`error-${call.id}`}
                className="break-words text-amber-800 dark:text-amber-300"
              >
                {call.error}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
};

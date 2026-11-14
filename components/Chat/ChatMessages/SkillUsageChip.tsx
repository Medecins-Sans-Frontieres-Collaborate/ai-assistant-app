'use client';

import {
  IconAlertCircle,
  IconChevronDown,
  IconChevronRight,
} from '@tabler/icons-react';
import { FC, useId, useState } from 'react';

import { useTranslations } from 'next-intl';

import {
  SkillUsageLine,
  skillUsageHasIssue,
  skillUsageNeedsAttention,
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
 * compact disclosure leaves automatic work in the background. Explicit
 * omissions and approval requirements retain attention styling; names,
 * selection methods, versions and diagnostics remain available on demand.
 */
export const SkillUsageChip: FC<SkillUsageChipProps> = ({ toolCalls }) => {
  const t = useTranslations('chat.skillUsage');
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  const finishedCalls = toolCalls.filter(
    (call) => call.status !== 'in_progress',
  );
  if (finishedCalls.length === 0) return null;

  const lines = summarizeSkillToolCalls(finishedCalls);
  const issue = skillUsageHasIssue(finishedCalls);
  const attention = skillUsageNeedsAttention(finishedCalls);

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
        return `${t('references', { count: line.count })}${line.unavailable ? `; ${t('referencesUnavailable')}` : ''}`;
      case 'agentLoad':
        return `${line.name} (${line.failed ? t('unavailable') : t('agentLoad')})`;
      case 'agentSearch':
        return `${t('agentSearch')}${line.failed ? ` (${t('unavailable')})` : ''}`;
      case 'note':
        return null;
    }
  };
  const named = lines.filter(
    (line) => line.kind === 'skill' || line.kind === 'agentLoad',
  );
  const count = named.length;
  const inline = lines
    .filter(
      (line) =>
        line.kind === 'unavailable' ||
        line.kind === 'consent' ||
        (attention && line.kind === 'agentLoad' && line.failed) ||
        (line.kind === 'skill' && line.via !== 'auto'),
    )
    .map(label)
    .filter((text): text is string => !!text);
  const notes = lines.filter(
    (line): line is Extract<SkillUsageLine, { kind: 'note' }> =>
      line.kind === 'note',
  );
  const detailLabels = lines
    .filter((line) => line.kind !== 'note')
    .map(label)
    .filter((text): text is string => !!text);
  const summary = inline.length
    ? inline.join(', ')
    : attention
      ? t('incomplete')
      : issue
        ? t('limited')
        : count
          ? t('appliedCount', { count })
          : null;

  return (
    <div
      className="my-1 max-w-prose not-prose"
      data-testid="skill-usage-chip"
      data-attention={attention ? 'required' : 'background'}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={expanded ? t('hideDetails') : t('showDetails')}
        className={`inline-flex min-h-8 max-w-full items-center gap-1.5 rounded py-1 text-start text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 [@media(pointer:coarse)]:min-h-11 ${attention ? 'text-amber-900 hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-100' : 'text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100'}`}
      >
        {attention && (
          <IconAlertCircle size={12} aria-hidden="true" className="shrink-0" />
        )}
        <span className="min-w-0 break-words">
          {t('label')}
          {summary ? ` · ${summary}` : ''}
        </span>
        {expanded ? (
          <IconChevronDown size={12} aria-hidden="true" className="shrink-0" />
        ) : (
          <IconChevronRight size={12} aria-hidden="true" className="shrink-0" />
        )}
      </button>
      {expanded && (
        <ul
          id={detailsId}
          className="mt-1 space-y-1 text-xs leading-relaxed text-gray-700 dark:text-gray-300"
        >
          {detailLabels.map((text, index) => (
            <li key={`detail-${index}`} className="break-words">
              {text}
            </li>
          ))}
          {notes.map((note, index) => (
            <li key={`note-${index}`} className="break-words">
              {note.text}
            </li>
          ))}
          {finishedCalls
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

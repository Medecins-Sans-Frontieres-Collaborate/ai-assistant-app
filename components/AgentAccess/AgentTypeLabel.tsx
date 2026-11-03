'use client';

import {
  IconCloud,
  IconDatabase,
  IconFiles,
  IconRobot,
} from '@tabler/icons-react';
import type { FC } from 'react';

import { useTranslations } from 'next-intl';

/** Origin and backing are distinct: a files agent may use M365 or uploaded files. */
export type AdminAgentKind = 'foundry' | 'prompt' | 'files' | 'knowledge';

interface AgentTypeLabelProps {
  kind: AdminAgentKind;
  sourceLabel?: string;
}

/** A neutral icon plus text, never a health or access-policy indicator. */
export const AgentTypeLabel: FC<AgentTypeLabelProps> = ({
  kind,
  sourceLabel,
}) => {
  const t = useTranslations('agentAccess');
  const tFiles = useTranslations('analyticsAdmin.health.total');
  const icons = {
    foundry: IconCloud,
    prompt: IconRobot,
    files: IconFiles,
    knowledge: IconDatabase,
  };
  const Icon = icons[kind];
  const label =
    kind === 'foundry'
      ? 'Foundry'
      : `${t('nativeLabel')} · ${kind === 'files' ? tFiles('files') : kind === 'prompt' ? t('promptAgentBadge') : t('orgAgentBadge')}`;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
      <Icon aria-hidden="true" size={15} className="shrink-0" />
      <span>
        {label}
        {sourceLabel ? ` · ${sourceLabel}` : ''}
      </span>
    </span>
  );
};

import { IconPin, IconX } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { useSkillSelection } from '@/client/hooks/settings/useSkillSelection';

import { useChatInputStore } from '@/client/stores/chatInputStore';

/** Persistent pins and next-message selections, including removable stale ids. */
export function SkillBadges() {
  const t = useTranslations('chat');
  const {
    query,
    pinned,
    explicit,
    disabled,
    agentAttached,
    togglePin,
    toggleOnce,
  } = useSkillSelection();
  const openTray = useChatInputStore((state) => state.setConnectorPinTrayOpen);
  if (!query.data?.length && !explicit.length) return null;
  return (
    <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-700 dark:text-gray-300">
      <button
        type="button"
        onClick={() => openTray(true)}
        className="min-h-11 rounded-lg border border-gray-300 px-3 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-600 dark:hover:bg-gray-800"
      >
        {t('addSkill')}
      </button>
      {explicit.map((id) => {
        const skill = query.data?.find((entry) => entry.id === id);
        const isPinned = pinned.includes(id);
        const state =
          disabled || (agentAttached && !skill)
            ? t('skillsPaused')
            : !skill && !query.isPending
              ? t('skillUnavailable')
              : isPinned
                ? t('skillPinned')
                : t('skillOnce');
        return (
          <span
            key={id}
            className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-gray-300 ps-3 dark:border-gray-600"
          >
            {isPinned && <IconPin size={14} aria-hidden="true" />}
            <span className="min-w-0 break-words">
              {skill?.name ?? id}
              {skill?.personal ? ` (${t('skillPersonal')})` : ''}{' '}
              <span className="text-gray-600 dark:text-gray-400">
                ({state})
              </span>
            </span>
            <button
              type="button"
              onClick={() => (isPinned ? togglePin(id) : toggleOnce(id))}
              aria-label={`${t('removeSkill')}: ${skill?.name ?? id}`}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-gray-800"
            >
              <IconX size={16} aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

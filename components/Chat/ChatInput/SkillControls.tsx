import { useTranslations } from 'next-intl';

import { useSkillSelection } from '@/client/hooks/settings/useSkillSelection';

import { SKILL_LIMITS } from '@/lib/services/skills/types';

/** Capabilities-tray controls: use once or pin to this conversation. */
export function SkillControls() {
  const t = useTranslations('chat');
  const {
    query,
    pinned,
    requested,
    explicit,
    disabled,
    agentAttached,
    togglePin,
    toggleOnce,
  } = useSkillSelection();
  if (!query.data?.length && !explicit.length) return null;
  const buttonClass =
    'min-h-11 rounded-lg border border-gray-300 px-3 text-xs text-gray-700 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 aria-pressed:bg-blue-100 aria-pressed:text-blue-900 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800 dark:aria-pressed:bg-gray-700 dark:aria-pressed:text-gray-100';
  return (
    <section
      aria-label={t('skillsMenuLabel')}
      className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700"
    >
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('addSkill')}
      </h3>
      <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
        {agentAttached ? t('skillsAgentToolsHint') : t('skillsAutomaticHint')}
      </p>
      <ul className="mt-2 divide-y divide-gray-200 dark:divide-gray-700">
        {(query.data ?? []).map((skill) => {
          const isPinned = pinned.includes(skill.id);
          const isRequested = requested.includes(skill.id);
          const full =
            !explicit.includes(skill.id) &&
            explicit.length >= SKILL_LIMITS.maxForcedPerTurn;
          return (
            <li
              key={skill.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="break-words text-sm font-medium text-gray-700 dark:text-gray-300">
                  {skill.name}
                  {skill.personal ? ` (${t('skillPersonal')})` : ''}
                </p>
                <p className="mt-1 break-words text-xs text-gray-600 dark:text-gray-400">
                  {skill.description}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label={`${t('skillUseOnce')}: ${skill.name}`}
                  aria-pressed={isRequested}
                  disabled={disabled || full || isPinned}
                  onClick={() => toggleOnce(skill.id)}
                  className={buttonClass}
                >
                  {t('skillUseOnce')}
                </button>
                <button
                  type="button"
                  aria-label={`${t('skillPin')}: ${skill.name}`}
                  aria-pressed={isPinned}
                  disabled={!isPinned && (disabled || full)}
                  onClick={() => togglePin(skill.id)}
                  className={buttonClass}
                >
                  {t('skillPin')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {explicit.length >= SKILL_LIMITS.maxForcedPerTurn && (
        <p className="mt-2 text-xs text-gray-600 dark:text-gray-400">
          {t('skillsLimit')}
        </p>
      )}
    </section>
  );
}

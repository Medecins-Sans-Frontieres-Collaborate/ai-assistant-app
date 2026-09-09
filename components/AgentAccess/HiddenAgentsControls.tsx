'use client';

import { IconEye, IconEyeOff } from '@tabler/icons-react';
import { FC } from 'react';

import { useTranslations } from 'next-intl';

interface HideAgentButtonProps {
  hidden: boolean;
  onHide: () => void;
  onUnhide: () => void;
}

/** Row action: hide this agent from my admin list / bring it back. */
export const HideAgentButton: FC<HideAgentButtonProps> = ({
  hidden,
  onHide,
  onUnhide,
}) => {
  const t = useTranslations('agentAccess');
  return (
    <button
      type="button"
      onClick={hidden ? onUnhide : onHide}
      aria-label={t(hidden ? 'unhideAgent' : 'hideAgent')}
      title={t(hidden ? 'unhideAgentHint' : 'hideAgentHint')}
      className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 ${
        hidden
          ? 'border-amber-300 text-amber-800 dark:border-amber-700 dark:text-amber-300'
          : 'border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300'
      }`}
    >
      {hidden ? <IconEye size={14} /> : <IconEyeOff size={14} />}
      {t(hidden ? 'unhideAgent' : 'hideAgent')}
    </button>
  );
};

interface ShowHiddenToggleProps {
  hiddenCount: number;
  showHidden: boolean;
  onToggle: (show: boolean) => void;
}

/**
 * List header control: "N hidden — Show" / "Showing N hidden — Hide".
 * Renders nothing when nothing is hidden.
 */
export const ShowHiddenToggle: FC<ShowHiddenToggleProps> = ({
  hiddenCount,
  showHidden,
  onToggle,
}) => {
  const t = useTranslations('agentAccess');
  if (hiddenCount === 0) return null;
  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
      <IconEyeOff size={14} />
      <span>
        {t(showHidden ? 'hiddenAgentsShowing' : 'hiddenAgentsCount', {
          count: hiddenCount,
        })}
      </span>
      <button
        type="button"
        onClick={() => onToggle(!showHidden)}
        className="text-blue-700 hover:underline dark:text-blue-400"
      >
        {t(showHidden ? 'hiddenAgentsHide' : 'hiddenAgentsShow')}
      </button>
    </div>
  );
};

/** Badge for a hidden row when "Show hidden" is on. */
export const HiddenBadge: FC = () => {
  const t = useTranslations('agentAccess');
  return (
    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
      {t('hiddenBadge')}
    </span>
  );
};

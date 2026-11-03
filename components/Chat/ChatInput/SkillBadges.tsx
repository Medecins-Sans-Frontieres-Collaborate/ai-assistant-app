import { IconPinFilled, IconSparkles } from '@tabler/icons-react';

import { useTranslations } from 'next-intl';

import { useSkillSelection } from '@/client/hooks/settings/useSkillSelection';

import { CapabilityBubble } from '@/components/Chat/ChatInput/CapabilityBubble';

import { useChatInputStore } from '@/client/stores/chatInputStore';

/**
 * Skills in the composer's capability row: an entry bubble that opens the
 * tray, then one bubble per pinned / next-message skill (stale ids stay
 * removable). Icon-only until hovered or focused, like the agent and
 * connector bubbles beside it; the hover label carries the name and state,
 * the × removes the selection in place.
 */
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
  const trayOpen = useChatInputStore((state) => state.connectorPinTrayOpen);
  const setTrayOpen = useChatInputStore(
    (state) => state.setConnectorPinTrayOpen,
  );
  if (!query.data?.length && !explicit.length) return null;
  const toggleTray = () => setTrayOpen(!trayOpen);
  return (
    <>
      <CapabilityBubble
        icon={<IconSparkles size={14} className="text-amber-500" />}
        label={t('addSkill')}
        ariaExpanded={trayOpen}
        onClick={toggleTray}
      />
      {explicit.map((id) => {
        const skill = query.data?.find((entry) => entry.id === id);
        const isPinned = pinned.includes(id);
        const paused = disabled || (agentAttached && !skill);
        const unavailable = !paused && !skill && !query.isPending;
        const state = paused
          ? t('skillsPaused')
          : unavailable
            ? t('skillUnavailable')
            : isPinned
              ? t('skillPinned')
              : t('skillOnce');
        const name = `${skill?.name ?? id}${
          skill?.personal ? ` (${t('skillPersonal')})` : ''
        }`;
        const inert = paused || unavailable;
        const iconClass = inert ? 'text-gray-400' : 'text-amber-500';
        return (
          <CapabilityBubble
            key={id}
            icon={
              isPinned ? (
                <IconPinFilled size={14} className={iconClass} />
              ) : (
                <IconSparkles size={14} className={iconClass} />
              )
            }
            label={`${name} (${state})`}
            ariaExpanded={trayOpen}
            onClick={toggleTray}
            muted={inert}
            onRemove={() => (isPinned ? togglePin(id) : toggleOnce(id))}
            removeLabel={`${t('removeSkill')}: ${skill?.name ?? id}`}
          />
        );
      })}
    </>
  );
}

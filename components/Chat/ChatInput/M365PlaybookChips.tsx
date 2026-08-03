'use client';

import { IconSparkles, IconX } from '@tabler/icons-react';
import { FC, useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useConversations } from '@/client/hooks/conversation/useConversations';
import { useM365Enabled } from '@/client/hooks/useM365Enabled';

import { buildPlaybookContext } from '@/client/services/m365/playbooks/playbookContext';
import { fillComposerWithPlaybook } from '@/client/services/m365/playbooks/playbookLauncher';
import {
  M365PlaybookId,
  getEligiblePlaybooks,
} from '@/client/services/m365/playbooks/playbookRegistry';

import { useChatInputStore } from '@/client/stores/chatInputStore';
import { useSettingsStore } from '@/client/stores/settingsStore';

/**
 * Suggestion chips for the Microsoft 365 playbooks, rendered above the
 * composer when a playbook's precondition holds (a transcript is in the
 * conversation; it's morning and M365 is connected).
 *
 * Clicking a chip loads the playbook prompt lazily and fills the composer
 * with it — the user still reads, edits and sends it. Dismissing hides that
 * chip for the session only: this is a suggestion surface, so a dismissal
 * must not silently become a permanent setting. The permanent switch is
 * Settings → Connections ("Suggest Microsoft 365 playbooks").
 */
export const M365PlaybookChips: FC = () => {
  const t = useTranslations('m365.playbooks');
  // No `m365.playbooks.dismissChip` key exists yet, and messages/en.json is
  // owned elsewhere — the shared root-level "close" label carries the
  // dismiss affordance until one is added.
  const { playbooksEnabled } = useM365Enabled();
  const m365Connected = useSettingsStore((s) => s.m365Connected);
  const chipsEnabled = useSettingsStore((s) => s.m365PlaybookChipsEnabled);
  const filePreviews = useChatInputStore((s) => s.filePreviews);
  const { selectedConversation } = useConversations();
  const [dismissedIds, setDismissedIds] = useState<M365PlaybookId[]>([]);

  const messages = selectedConversation?.messages;
  const eligible = useMemo(
    () =>
      getEligiblePlaybooks(
        buildPlaybookContext({ messages, filePreviews, m365Connected }),
      ),
    [messages, filePreviews, m365Connected],
  );

  if (!playbooksEnabled || !chipsEnabled) return null;

  const visible = eligible.filter(
    (playbook) => !dismissedIds.includes(playbook.id),
  );
  if (visible.length === 0) return null;

  return (
    <div className="mx-3 my-2 flex flex-wrap items-center gap-2">
      {visible.map((playbook) => {
        const title = t(playbook.titleKey);
        return (
          <span
            key={playbook.id}
            className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 pl-2 pr-1 py-0.5 text-xs text-blue-800 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200"
          >
            <button
              type="button"
              onClick={() => void fillComposerWithPlaybook(playbook.id)}
              title={t(playbook.descriptionKey)}
              className="inline-flex items-center gap-1 rounded-full px-1 py-0.5 transition-colors hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:hover:bg-blue-800/50"
            >
              <IconSparkles size={12} aria-hidden="true" />
              {t('chipLabel', { title })}
            </button>
            <button
              type="button"
              onClick={() =>
                setDismissedIds((previous) => [...previous, playbook.id])
              }
              aria-label={t('dismissChip', { title })}
              title={t('dismissChip', { title })}
              className="rounded-full p-0.5 text-blue-500 transition-colors hover:bg-blue-100 hover:text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:text-blue-300 dark:hover:bg-blue-800/50"
            >
              <IconX size={11} aria-hidden="true" />
            </button>
          </span>
        );
      })}
    </div>
  );
};

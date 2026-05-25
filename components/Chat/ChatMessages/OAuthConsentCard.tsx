'use client';

import {
  IconArrowRight,
  IconExternalLink,
  IconKey,
  IconLoader2,
} from '@tabler/icons-react';
import { FC, useState } from 'react';

import { useTranslations } from 'next-intl';

import { flattenEntriesForAPI } from '@/lib/utils/shared/chat/messageVersioning';

import type { ConsentRequest } from './ConsentCard';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';

interface OAuthConsentCardProps {
  request: ConsentRequest & { kind: 'oauth' };
}

/**
 * Consent card for the MCP OAuth flow. After the user clicks Authorize the
 * card surfaces a Continue button that re-sends the last user message
 * verbatim — the message is replayed unchanged because the user already
 * authored it; no pre-processing or input-bar normalization is needed.
 */
export const OAuthConsentCard: FC<OAuthConsentCardProps> = ({ request }) => {
  const t = useTranslations('chat.consent');
  const serverLabel = request.server_label?.trim() || null;
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const pendingOAuthResume = useChatStore((s) => s.pendingOAuthResume);
  const setPendingOAuthResume = useChatStore((s) => s.setPendingOAuthResume);
  const selectedConversation = useConversationStore((s) =>
    s.selectedConversationId
      ? (s.conversations.find((c) => c.id === s.selectedConversationId) ?? null)
      : null,
  );

  // Capture once on mount: if this card mounts while a pendingOAuthResume
  // matches its server, the user's last Continue didn't complete an upstream
  // sign-in. Render the "incomplete" framing. Snapshotted via useState so
  // a later clear of the store value doesn't flip the card back; explicit
  // clear happens in chatStore.clearStreamingState to age out stale state.
  const [incompleteSignIn] = useState(
    () =>
      !!pendingOAuthResume &&
      (pendingOAuthResume.serverLabel ?? null) === serverLabel,
  );

  const [oauthClicked, setOauthClicked] = useState(false);
  const [resuming, setResuming] = useState(false);

  const handleContinue = () => {
    if (!selectedConversation || resuming || isStreaming) return;
    const flat = flattenEntriesForAPI(selectedConversation.messages);
    const lastUser = [...flat].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;
    // Mark a resume in flight so a follow-up OAuth card for the same
    // server can render the "didn't complete" message instead of the
    // original prompt.
    setPendingOAuthResume({ serverLabel });
    setResuming(true);
    void sendMessage(lastUser, selectedConversation).finally(() => {
      setResuming(false);
    });
  };

  const continueDisabled = !selectedConversation || resuming || isStreaming;

  return (
    <div className="my-3 max-w-prose rounded-xl border border-amber-200/80 bg-amber-50/60 p-4 not-prose dark:border-amber-700/40 dark:bg-amber-900/15">
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-lg bg-amber-100 p-2 dark:bg-amber-900/40">
          <IconKey
            size={18}
            className="text-amber-700 dark:text-amber-300"
            aria-hidden="true"
          />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-white">
            {incompleteSignIn
              ? serverLabel
                ? t('signInIncompleteForService', { service: serverLabel })
                : t('signInIncompleteGeneric')
              : serverLabel
                ? t('authorizeService', { service: serverLabel })
                : t('authorizeRequired')}
          </h4>
          <p className="mt-1 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
            {incompleteSignIn
              ? serverLabel
                ? t('signInIncompleteDescription', { service: serverLabel })
                : t('signInIncompleteDescriptionGeneric')
              : serverLabel
                ? t('descriptionWithService', { service: serverLabel })
                : t('descriptionGeneric')}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a
              href={request.consent_url}
              target="_blank"
              rel="noreferrer noopener"
              onClick={() => setOauthClicked(true)}
              className={
                oauthClicked
                  ? 'inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/40'
                  : 'inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600'
              }
            >
              {oauthClicked ? t('reauthorizeButton') : t('authorizeButton')}
              <IconExternalLink size={14} aria-hidden="true" />
            </a>

            {oauthClicked && (
              <button
                type="button"
                onClick={handleContinue}
                disabled={continueDisabled}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-700 dark:hover:bg-amber-600"
              >
                {resuming ? (
                  <IconLoader2
                    size={14}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <IconArrowRight size={14} aria-hidden="true" />
                )}
                {t('continueButton')}
              </button>
            )}
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {oauthClicked ? t('continueHint') : t('authorizeHint')}
          </p>
        </div>
      </div>
    </div>
  );
};

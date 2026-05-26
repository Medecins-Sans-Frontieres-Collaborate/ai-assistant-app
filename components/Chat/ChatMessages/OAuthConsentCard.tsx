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

import type { Message } from '@/types/chat';

import type { ConsentRequest } from './ConsentCard';

import { useChatStore } from '@/client/stores/chatStore';
import { useConversationStore } from '@/client/stores/conversationStore';

interface OAuthConsentCardProps {
  request: ConsentRequest & { kind: 'oauth' };
  messageIndex?: number;
}

const OAUTH_SETTLE_MS = 1500;

export const OAuthConsentCard: FC<OAuthConsentCardProps> = ({
  request,
  messageIndex,
}) => {
  const t = useTranslations('chat.consent');
  const serverLabel = request.server_label?.trim() || null;
  const sendMessage = useChatStore((s) => s.sendMessage);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const pendingForThisServer = useChatStore(
    (s) => !!s.pendingOAuthResume[serverLabel ?? ''],
  );
  const setPendingOAuthResume = useChatStore((s) => s.setPendingOAuthResume);
  const selectedConversation = useConversationStore((s) =>
    s.selectedConversationId
      ? (s.conversations.find((c) => c.id === s.selectedConversationId) ?? null)
      : null,
  );

  const [incompleteSignIn] = useState(() => pendingForThisServer);

  const [oauthClicked, setOauthClicked] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'settling'>('idle');

  const handleContinue = () => {
    if (!selectedConversation || phase !== 'idle' || isStreaming) return;

    const flat = flattenEntriesForAPI(selectedConversation.messages);

    let triggeringUser: Message | undefined;
    if (typeof messageIndex === 'number') {
      if (messageIndex > 0) {
        for (let i = Math.min(messageIndex - 1, flat.length - 1); i >= 0; i--) {
          if (flat[i].role === 'user') {
            triggeringUser = flat[i];
            break;
          }
        }
      }
    } else {
      triggeringUser = [...flat].reverse().find((m) => m.role === 'user');
    }
    if (!triggeringUser) return;

    setPendingOAuthResume({ serverLabel });
    setPhase('settling');

    window.setTimeout(() => {
      void sendMessage(triggeringUser!, selectedConversation).finally(() => {
        setPhase('idle');
      });
    }, OAUTH_SETTLE_MS);
  };

  const settling = phase === 'settling';
  const continueDisabled = !selectedConversation || settling || isStreaming;

  return (
    <div className="my-3 max-w-prose rounded-xl border border-amber-200/80 bg-amber-50/60 p-4 not-prose dark:border-amber-700/40 dark:bg-amber-900/15 transition-opacity">
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
              aria-disabled={settling || undefined}
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
                aria-busy={settling || undefined}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-amber-700 dark:hover:bg-amber-600"
              >
                {settling ? (
                  <IconLoader2
                    size={14}
                    className="animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <IconArrowRight size={14} aria-hidden="true" />
                )}
                {settling ? t('confirmingButton') : t('continueButton')}
              </button>
            )}
          </div>
          <p
            className={`mt-2 text-xs transition-colors ${
              settling
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {settling
              ? t('confirmingHint')
              : oauthClicked
                ? t('continueHint')
                : t('authorizeHint')}
          </p>
        </div>
      </div>
    </div>
  );
};

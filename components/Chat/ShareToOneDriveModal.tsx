'use client';

import {
  IconBrandOnedrive,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconLoader2,
} from '@tabler/icons-react';
import { FC, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { buildBlob } from '@/client/hooks/document/useM365Save';
import {
  TypeaheadFetch,
  useTypeaheadSuggestions,
} from '@/client/hooks/useTypeaheadSuggestions';

import {
  saveToOneDrive,
  searchPeople,
  shareDriveItem,
} from '@/client/services/m365/m365Client';
import { m365ErrorKind } from '@/client/services/m365/m365ErrorKinds';

import {
  collectShareMessages,
  renderShareMarkdown,
} from '@/lib/utils/app/share/shareContent';
import { markdownToHtml } from '@/lib/utils/shared/document/formatConverter';

import { Conversation, Message } from '@/types/chat';

import Modal from '@/components/UI/Modal';
import {
  TypeaheadDropdown,
  typeaheadDropdownOpen,
} from '@/components/UI/TypeaheadDropdown';

interface ShareToOneDriveModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversation: Conversation | null;
  /**
   * Pre-cleaned markdown of ONE message ("share this answer"). When set,
   * the message filters are irrelevant and hidden.
   */
  messageContent?: string | null;
}

interface ShareOutcome {
  /** The link recipients use (org link, or the file URL for people-grants). */
  link?: string;
  grantedCount?: number;
  fileName: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Characters OneDrive rejects in file names. The server sanitizes too —
 * stripping client-side keeps the name in the success message identical to
 * the file that actually lands in OneDrive.
 */
const INVALID_FILENAME_CHARS_RE = /[\\/:*?"<>|#%]/g;

function parseEmails(raw: string): { emails: string[]; invalid: string[] } {
  const parts = raw
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    emails: parts.filter((part) => EMAIL_RE.test(part)),
    invalid: parts.filter((part) => !EMAIL_RE.test(part)),
  };
}

/** The token being typed: text after the last separator. */
function currentToken(raw: string): string {
  const parts = raw.split(/[,;\s]+/);
  return parts[parts.length - 1] ?? '';
}

/** Replaces the in-progress token with the chosen email, ready for more. */
function completeToken(raw: string, email: string): string {
  const token = currentToken(raw);
  return `${raw.slice(0, raw.length - token.length)}${email}, `;
}

/**
 * Share a conversation (or one message) as a readable document in the
 * user's OneDrive, permissioned via Graph: an organization view link by
 * default, or view grants for specific people. The default path is
 * one-click; filters and recipients live behind a collapsed "Customize"
 * disclosure so they never crowd the simple case.
 */
export const ShareToOneDriveModal: FC<ShareToOneDriveModalProps> = ({
  isOpen,
  onClose,
  conversation,
  messageContent = null,
}) => {
  const t = useTranslations('share');

  const [title, setTitle] = useState('');
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [assistantOnly, setAssistantOnly] = useState(false);
  const [limitEnabled, setLimitEnabled] = useState(false);
  const [lastCount, setLastCount] = useState(10);
  const [recipientsRaw, setRecipientsRaw] = useState('');
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [outcome, setOutcome] = useState<ShareOutcome | null>(null);
  const [copied, setCopied] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // People autocomplete for the in-progress recipient token, on the shared
  // typeahead machinery (searching / no-matches feedback included).
  // Suggestions are a convenience: any fetch failure (not connected, consent
  // gap, throttle) silently yields none and typing plain emails keeps
  // working. The modal only opens on sharing-enabled + connected surfaces,
  // so no additional gate is needed here.
  const suggestPeople: TypeaheadFetch = async (q, signal) =>
    (await searchPeople(q, signal)).map((person) => ({
      label: person.displayName,
      value: person.email,
    }));
  const {
    suggestions,
    status: suggestStatus,
    activeIndex: activeSuggestion,
    setActiveIndex: setActiveSuggestion,
    query: querySuggestions,
    clear: clearSuggestions,
  } = useTypeaheadSuggestions(suggestPeople);

  const handleRecipientsChange = (value: string) => {
    setRecipientsRaw(value);
    // Don't resurface people already added as recipients.
    querySuggestions(currentToken(value), parseEmails(value).emails);
  };

  const selectSuggestion = (email: string) => {
    setRecipientsRaw((prev) => completeToken(prev, email));
    clearSuggestions();
  };

  // Reset per open — a share dialog must never leak the previous share's
  // filters, recipients, or result into the next one. Deliberately keyed on
  // isOpen ALONE: `t` (new closure every render) or a parent-recreated
  // conversation object in the deps would re-fire this mid-interaction and
  // silently collapse the user's in-progress choices.
  useEffect(() => {
    if (!isOpen) return;
    setTitle(conversation?.name?.trim() || t('defaultTitle'));
    setCustomizeOpen(false);
    setAssistantOnly(false);
    setLimitEnabled(false);
    setLastCount(10);
    setRecipientsRaw('');
    setRecipientsError(null);
    setIsSharing(false);
    setOutcome(null);
    setCopied(false);
    clearSuggestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const handleShare = async () => {
    if (isSharing) return;
    const { emails, invalid } = parseEmails(recipientsRaw);
    if (invalid.length > 0) {
      setRecipientsError(t('invalidRecipients', { list: invalid.join(', ') }));
      return;
    }
    setRecipientsError(null);
    setIsSharing(true);
    try {
      const messages: Message[] = messageContent
        ? [{ role: 'assistant', content: messageContent } as Message]
        : conversation
          ? collectShareMessages(conversation, {
              assistantOnly,
              ...(limitEnabled ? { lastCount } : {}),
            })
          : [];
      if (messages.length === 0) {
        toast.error(t('nothingToShare'));
        return;
      }

      const markdown = renderShareMarkdown(title, messages, {
        user: t('roleUser'),
        assistant: t('roleAssistant'),
      });
      const blob = await buildBlob('docx', markdownToHtml(markdown), markdown);
      // The document heading keeps the title as typed; only the FILE name
      // needs OneDrive's character rules applied.
      const safeTitle =
        title.replace(INVALID_FILENAME_CHARS_RE, '').trim() ||
        t('defaultTitle');
      const saved = await saveToOneDrive(blob, `${safeTitle}.docx`);
      if (!saved.itemId || !saved.driveId) {
        throw new Error('Save returned no item reference');
      }

      const share = await shareDriveItem(
        saved.driveId,
        saved.itemId,
        emails.length > 0 ? emails : undefined,
      );
      setOutcome({
        link: share.link ?? saved.webUrl,
        ...(share.scope === 'people' && { grantedCount: share.granted }),
        fileName: saved.name,
      });
    } catch (error) {
      const kind = m365ErrorKind(error);
      toast.error(
        kind === 'consentMissing'
          ? t('consentMissing')
          : kind === 'forbidden'
            ? t('blockedByPolicy')
            : t('failed'),
      );
    } finally {
      setIsSharing(false);
    }
  };

  const handleCopy = async () => {
    if (!outcome?.link) return;
    try {
      await navigator.clipboard.writeText(outcome.link);
    } catch {
      // Clipboard permission denied (or no clipboard API): the failure must
      // be visible, not a silent no-op — the link stays selectable above.
      toast.error(t('copyFailed'));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const checkboxClasses =
    'flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('title')}
      icon={<IconBrandOnedrive size={22} />}
      size="md"
      initialFocusRef={titleInputRef}
    >
      {outcome ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {outcome.grantedCount !== undefined
              ? t('sharedWithPeople', {
                  count: outcome.grantedCount,
                  name: outcome.fileName,
                })
              : t('sharedAsLink', { name: outcome.fileName })}
          </p>
          {outcome.link && (
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={outcome.link}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200"
              />
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                {copied ? t('copied') : t('copyLink')}
              </button>
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {t('done')}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {messageContent ? t('introMessage') : t('introConversation')}{' '}
            {t('attachmentsNote')}
          </p>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
              {t('documentTitle')}
            </span>
            <input
              ref={titleInputRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
            />
          </label>

          <div>
            <button
              type="button"
              onClick={() => setCustomizeOpen(!customizeOpen)}
              aria-expanded={customizeOpen}
              className="flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {customizeOpen ? (
                <IconChevronDown size={16} />
              ) : (
                <IconChevronRight size={16} />
              )}
              {t('customize')}
            </button>

            {customizeOpen && (
              <div className="mt-3 space-y-3 border-l-2 border-gray-200 pl-4 dark:border-gray-700">
                {!messageContent && (
                  <>
                    <label className={checkboxClasses}>
                      <input
                        type="checkbox"
                        checked={assistantOnly}
                        onChange={(e) => setAssistantOnly(e.target.checked)}
                      />
                      {t('assistantOnly')}
                    </label>
                    {/* The checkbox's label must not also wrap the number
                        input — that would leave the count field without an
                        accessible name of its own. */}
                    <div className={checkboxClasses}>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={limitEnabled}
                          onChange={(e) => setLimitEnabled(e.target.checked)}
                        />
                        {t('lastMessagesPre')}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={500}
                        value={lastCount}
                        disabled={!limitEnabled}
                        aria-label={t('lastMessagesCountLabel')}
                        onChange={(e) =>
                          setLastCount(Math.max(1, Number(e.target.value) || 1))
                        }
                        className="w-16 rounded border border-gray-300 px-2 py-1 text-sm disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800"
                      />
                      {t('lastMessagesPost')}
                    </div>
                  </>
                )}
                <label className="relative block">
                  <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-400">
                    {t('recipients')}
                  </span>
                  <input
                    value={recipientsRaw}
                    onChange={(e) => handleRecipientsChange(e.target.value)}
                    onBlur={() => clearSuggestions()}
                    onKeyDown={(e) => {
                      if (suggestions.length === 0) return;
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setActiveSuggestion(
                          (activeSuggestion + 1) % suggestions.length,
                        );
                      } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setActiveSuggestion(
                          (activeSuggestion - 1 + suggestions.length) %
                            suggestions.length,
                        );
                      } else if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault();
                        selectSuggestion(suggestions[activeSuggestion].value);
                      } else if (e.key === 'Escape') {
                        clearSuggestions();
                      }
                    }}
                    role="combobox"
                    aria-expanded={typeaheadDropdownOpen(
                      suggestStatus,
                      suggestions.length,
                    )}
                    aria-autocomplete="list"
                    aria-controls="share-people-suggestions"
                    aria-activedescendant={
                      suggestions.length > 0
                        ? `share-people-suggestions-option-${activeSuggestion}`
                        : undefined
                    }
                    placeholder={t('recipientsPlaceholder')}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                  />
                  <TypeaheadDropdown
                    listId="share-people-suggestions"
                    suggestions={suggestions}
                    status={suggestStatus}
                    activeIndex={activeSuggestion}
                    onSelect={selectSuggestion}
                    onHover={setActiveSuggestion}
                    listLabel={t('recipients')}
                  />
                  <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                    {t('recipientsHint')}
                  </span>
                  {recipientsError && (
                    <span className="mt-1 block text-xs text-red-600 dark:text-red-400">
                      {recipientsError}
                    </span>
                  )}
                </label>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSharing}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleShare()}
              disabled={isSharing || !title.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {isSharing && <IconLoader2 size={16} className="animate-spin" />}
              {isSharing ? t('sharing') : t('shareAction')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};

export default ShareToOneDriveModal;

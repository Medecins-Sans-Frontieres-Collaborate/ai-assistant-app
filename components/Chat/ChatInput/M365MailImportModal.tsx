import {
  IconMail,
  IconMailOpened,
  IconMessages,
  IconPaperclip,
  IconSearch,
} from '@tabler/icons-react';
import { FC, FormEvent, useCallback, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useM365Attachment } from '@/client/hooks/chat/useM365Attachment';

import { M365ClientError, listMail } from '@/client/services/m365/m365Client';

import type { M365MailEnvelope } from '@/types/m365';

import Modal from '@/components/UI/Modal';

interface M365MailImportModalProps {
  isOpen: boolean;
  onClose: () => void;
}

function errorMessageKey(error: unknown): string {
  if (error instanceof M365ClientError) {
    if (error.code === 'M365_CONSENT_MISSING') return 'errors.consentMissing';
    if (error.code === 'M365_NOT_CONNECTED') return 'errors.notConnected';
    if (error.code === 'NETWORK') return 'errors.network';
  }
  return 'errors.generic';
}

function formatDate(iso: string | undefined, locale?: string): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(locale, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return '';
  }
}

/**
 * Search the user's mailbox and import a message — or its whole thread — as
 * a markdown conversation attachment. Read-only: attachment contents are
 * never fetched (the imported document lists their names), and nothing is
 * written back to the mailbox.
 */
const M365MailImportBody: FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useTranslations('m365.mail');
  const { attachMail } = useM365Attachment();

  const [query, setQuery] = useState('');
  const [envelopes, setEnvelopes] = useState<M365MailEnvelope[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const load = useCallback(async (q?: string) => {
    setErrorKey(null);
    setLoading(true);
    try {
      setEnvelopes(await listMail(q));
    } catch (error) {
      setErrorKey(errorMessageKey(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    void load(query.trim() || undefined);
  };

  const importMail = (
    envelope: M365MailEnvelope,
    mode: 'message' | 'thread',
  ) => {
    // Continues in the background; progress shows on the attachment tile.
    void attachMail(envelope, mode);
    onClose();
  };

  return (
    <div className="flex h-[420px] flex-col gap-3">
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <IconSearch
            size={16}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full rounded-lg border border-gray-300 bg-gray-50 py-1.5 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
          />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40"
        >
          {t('search')}
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-700">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            {t('loading')}
          </div>
        ) : errorKey ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-amber-700 dark:text-amber-400">
            {t(errorKey)}
          </div>
        ) : envelopes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
            {t('empty')}
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-700/50">
            {envelopes.map((envelope) => (
              <li key={envelope.id} className="px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        {envelope.subject}
                      </span>
                      {envelope.hasAttachments && (
                        <IconPaperclip
                          size={13}
                          className="flex-shrink-0 text-gray-400"
                        />
                      )}
                    </div>
                    <div className="truncate text-xs text-gray-600 dark:text-gray-400">
                      {envelope.from}
                      {envelope.received &&
                        ` · ${formatDate(envelope.received)}`}
                    </div>
                    {envelope.preview && (
                      <div className="mt-0.5 line-clamp-1 text-xs text-gray-500 dark:text-gray-500">
                        {envelope.preview}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => importMail(envelope, 'message')}
                      title={t('importMessage')}
                      className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                    >
                      <IconMailOpened size={14} />
                      {t('message')}
                    </button>
                    {envelope.conversationId && (
                      <button
                        type="button"
                        onClick={() => importMail(envelope, 'thread')}
                        title={t('importThread')}
                        className="flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
                      >
                        <IconMessages size={14} />
                        {t('thread')}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-500">
        {t('attachmentsNotImported')}
      </p>
    </div>
  );
};

const M365MailImportModal: FC<M365MailImportModalProps> = ({
  isOpen,
  onClose,
}) => {
  const t = useTranslations('m365.mail');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('title')}
      icon={<IconMail size={20} />}
      size="lg"
    >
      {isOpen && <M365MailImportBody onClose={onClose} />}
    </Modal>
  );
};

export default M365MailImportModal;

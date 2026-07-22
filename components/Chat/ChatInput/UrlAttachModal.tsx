import { IconLink } from '@tabler/icons-react';
import { FC, FormEvent, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useUrlAttachment } from '@/client/hooks/chat/useUrlAttachment';

import { isLikelyUrl } from '@/client/services/url/urlFetchClient';

import Modal from '@/components/UI/Modal';

interface UrlAttachModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The form lives in its own component, mounted only while the modal is open,
 * so each opening starts blank without a reset effect.
 */
const UrlAttachForm: FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useTranslations('urlFetch');
  const { attachUrl } = useUrlAttachment();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const url = value.trim();
    if (!isLikelyUrl(url)) {
      setInvalid(true);
      return;
    }
    // Fetching continues in the background; progress shows on the tile.
    void attachUrl(url);
    onClose();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('attachLinkDescription')}
      </p>
      <input
        ref={inputRef}
        type="url"
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        placeholder={t('attachLinkPlaceholder')}
        aria-invalid={invalid}
        aria-label={t('attachLinkTitle')}
        className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark-elevated dark:text-gray-100 dark:placeholder-gray-400"
      />
      {invalid && (
        <p className="text-sm text-red-700 dark:text-red-400" role="alert">
          {t('attachLinkInvalid')}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!value.trim()}
          className="min-h-[36px] rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40"
        >
          {t('attachLinkSubmit')}
        </button>
      </div>
    </form>
  );
};

/**
 * Explicit "attach a web page" entry point, for when a link isn't being pasted
 * or when automatic fetching is switched off.
 */
const UrlAttachModal: FC<UrlAttachModalProps> = ({ isOpen, onClose }) => {
  const t = useTranslations('urlFetch');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('attachLinkTitle')}
      icon={<IconLink size={20} />}
      size="md"
    >
      <UrlAttachForm onClose={onClose} />
    </Modal>
  );
};

export default UrlAttachModal;

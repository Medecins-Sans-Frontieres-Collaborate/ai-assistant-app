import { IconInfoCircle } from '@tabler/icons-react';
import { FC, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import Modal from '@/components/UI/Modal';

interface PromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (name: string, description: string, content: string) => void;
  initialName?: string;
  initialDescription?: string;
  initialContent?: string;
  title?: string;
}

export const PromptModal: FC<PromptModalProps> = ({
  isOpen,
  onClose,
  onSave,
  initialName = '',
  initialDescription = '',
  initialContent = '',
  title,
}) => {
  const t = useTranslations();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [content, setContent] = useState(initialContent);
  const [showInfo, setShowInfo] = useState(false);

  // Sync with initial values when modal opens or props change
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        setName(initialName);
        setDescription(initialDescription);
        setContent(initialContent);
        setShowInfo(false);
      }, 0);
    }
  }, [isOpen, initialName, initialDescription, initialContent]);

  const handleSave = () => {
    if (!name.trim()) return;
    onSave(name.trim(), description.trim(), content);
    handleClose();
  };

  const handleClose = () => {
    setName('');
    setDescription('');
    setContent('');
    setShowInfo(false);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title={title || (initialName ? t('Edit Prompt') : t('New Prompt'))}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            className="px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 rounded-md"
            onClick={handleClose}
          >
            {t('Cancel')}
          </button>
          <button
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSave}
            disabled={!name.trim()}
          >
            {t('Save')}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <div>
          <label className="block text-sm font-bold mb-2 text-black dark:text-white">
            {t('Name')}
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('A name for your prompt_')}
            className="w-full rounded-lg border border-neutral-200 dark:border-neutral-600 bg-transparent px-4 py-3 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-bold mb-2 text-black dark:text-white">
            {t('Description')}
            <span className="text-xs text-gray-500 dark:text-gray-400 ml-2 font-normal">
              ({t('Optional')})
            </span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('A description for your prompt_')}
            rows={3}
            className="w-full rounded-lg border border-neutral-200 dark:border-neutral-600 bg-transparent px-4 py-3 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        <div>
          <label className="block text-sm font-bold mb-2 text-black dark:text-white">
            {t('Prompt')}
          </label>

          {/* Collapsible Info Section */}
          <div className="mb-2">
            <button
              onClick={() => setShowInfo(!showInfo)}
              className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
            >
              <IconInfoCircle size={14} />
              <span className="font-medium">{t('What is this?')}</span>
            </button>

            {showInfo && (
              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/40 rounded-lg px-3 py-2 border border-gray-200 dark:border-gray-700">
                <p className="mb-2">
                  <span className="font-medium">Prompts</span> are reusable
                  message templates that you can quickly access by typing{' '}
                  <code className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">
                    /
                  </code>{' '}
                  in the chat.
                </p>
                <p className="mb-2">
                  <span className="font-medium">Variables:</span> Use{' '}
                  <code className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">
                    {'{{variable}}'}
                  </code>{' '}
                  syntax to create dynamic placeholders. You&apos;ll be prompted
                  to fill them in when using the prompt.
                </p>
                <p className="text-gray-600 dark:text-gray-500">
                  Example:{' '}
                  <code className="text-xs">
                    Summarize {'{{topic}}'} in {'{{length}}'} words
                  </code>
                </p>
              </div>
            )}
          </div>

          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t(
              'Prompt content_ Use {{}} to denote a variable_ Ex: {{name}} is a {{adjective}} {{noun}}',
            )}
            rows={8}
            className="w-full rounded-lg border border-neutral-200 dark:border-neutral-600 bg-transparent px-4 py-3 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono text-sm"
          />
        </div>
      </div>
    </Modal>
  );
};

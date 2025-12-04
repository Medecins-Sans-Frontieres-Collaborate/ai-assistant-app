import { IconLanguage } from '@tabler/icons-react';
import { FC } from 'preact/compat';
import React, {
  Dispatch,
  SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { useTranslation } from 'next-i18next';

import BetaBadge from '@/components/Beta/Badge';
import Modal from '@/components/UI/Modal';
import { useDocumentTranslationWithStatus } from '@/hooks/useDocumentTranslation';

interface ChatInputTranslateProps {
  setTextFieldValue: Dispatch<SetStateAction<string>>;
  handleSend: () => void;
  simulateClick: boolean;
  setParentModalIsOpen: Dispatch<SetStateAction<boolean>>;
  defaultText?: string | null | undefined;
}

const ChatInputTranslate: FC<ChatInputTranslateProps> = ({
  setTextFieldValue,
  handleSend,
  simulateClick,
  setParentModalIsOpen,
  defaultText,
}) => {
  const { t } = useTranslation('chat');

  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [inputText, setInputText] = useState(defaultText ?? '');
  const [sourceLanguage, setSourceLanguage] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('');
  const [translationType, setTranslationType] = useState('balanced');
  const [domainSpecific, setDomainSpecific] = useState('general');
  const [useFormalLanguage, setUseFormalLanguage] = useState(false);
  const [useGenderNeutralLanguage, setUseGenderNeutralLanguage] =
    useState(false);
  const [autoSubmit, setAutoSubmit] = useState<boolean>(true);
  const [isReadyToSend, setIsReadyToSend] = useState<boolean>(false);
  const [useTargetLanguageDropdown, setUseTargetLanguageDropdown] =
    useState<boolean>(true);
  const openModalButtonRef = useRef<HTMLButtonElement>(null);
  const inputTextRef = useRef<HTMLTextAreaElement>(null);

  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const {
    startTranslation,
    phase,
    jobId,
    startResponse,
    status,
    error: documentError,
    isPolling,
    stopPolling,
  } = useDocumentTranslationWithStatus({ pollIntervalMs: 2000 });

  useEffect(() => {
    if (isReadyToSend) {
      setIsReadyToSend(false); // Reset the flag
      handleSend();
      setParentModalIsOpen(false);
    }
  }, [isReadyToSend, handleSend, setParentModalIsOpen]);

  useEffect(() => {
    if (simulateClick && openModalButtonRef.current) {
      openModalButtonRef.current.click();
    }
  }, [simulateClick]);

  const closeModal = () => {
    setIsModalOpen(false);
    setParentModalIsOpen(false);
  };

  const languages = [
    { value: 'en', label: t('languageEnglish'), autonym: 'English' },
    { value: 'es', label: t('languageSpanish'), autonym: 'Español' },
    { value: 'fr', label: t('languageFrench'), autonym: 'Français' },
    { value: 'de', label: t('languageGerman'), autonym: 'Deutsch' },
    { value: 'nl', label: t('languageDutch'), autonym: 'Nederlands' },
    { value: 'it', label: t('languageItalian'), autonym: 'Italiano' },
    { value: 'pt', label: t('languagePortuguese'), autonym: 'Português' },
    { value: 'ru', label: t('languageRussian'), autonym: 'Русский' },
    { value: 'zh', label: t('languageChinese'), autonym: '中文' },
    { value: 'ja', label: t('languageJapanese'), autonym: '日本語' },
    { value: 'ko', label: t('languageKorean'), autonym: '한국어' },
    { value: 'ar', label: t('languageArabic'), autonym: 'العربية' },
    { value: 'hi', label: t('languageHindi'), autonym: 'हिन्दी' },
  ].sort((a, b) => a.label.localeCompare(b.label));

  const handleTranslate = () => {
    if (!inputText.trim()) {
      toast.error(t('translatorNoTextError'));
      return;
    }
    if (!targetLanguage) {
      toast.error(t('translatorNoTargetLanguageError'));
      return;
    }

    let prompt;
    if (!sourceLanguage) {
      prompt = `Translate the following text into the language with iso code \`${
        languages.find((l) => l.value === targetLanguage)?.value || 'unknown'
      }\`:\n\n\`\`\`\n${inputText}\n\`\`\``;
    } else {
      prompt = `Translate the following text from the language with the iso code \`${
        languages.find((l) => l.value === sourceLanguage)?.value ||
        'the original language'
      }\` to \`${
        languages.find((l) => l.value === targetLanguage)?.value || 'unknown'
      }\`:\n\n\`\`\`${sourceLanguage}\n${inputText}\n\`\`\``;
    }

    prompt +=
      '\n\nRespond with directly markdown formatted text (not in a code block) matching the original as closely as possible, making only language-appropriate adjustments.';

    // Include advanced options in the prompt if selected
    if (translationType !== 'balanced') {
      prompt += `\n\nTranslation type: ${translationType}`;
    } else {
      prompt +=
        '\n\nMake sure your translation balances between literal, figurative, and cultural translations in a way that intuitively captures the original meaning.';
    }
    if (domainSpecific !== 'general') {
      prompt += `\nDomain-specific terminology: ${domainSpecific}`;
    }
    if (useFormalLanguage) {
      prompt += `\nPlease use formal language.`;
    }
    if (useGenderNeutralLanguage) {
      prompt += `\nPlease use gender-neutral language.`;
    }

    setTextFieldValue(prompt);
    setIsModalOpen(false);
    setIsReadyToSend(autoSubmit);
    setInputText('');
  };

    // ---------------- DOCUMENT TRANSLATION (new) ----------------

  const handleStartDocumentTranslation = async () => {
    if (!documentFile) {
      toast.error('Please select a document to translate.');
      return;
    }
    if (!sourceLanguage) {
      toast.error('Please select a source language for the document.');
      return;
    }
    if (!targetLanguage) {
      toast.error('Please select a target language for the document.');
      return;
    }

    try {
      await startTranslation({
        file: documentFile,
        sourceLanguage,
        targetLanguage,
      });

      toast.success('Document translation started.');
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to start document translation.';
      toast.error(message);
    }
  };

  const isDocumentBusy =
    phase === 'starting' || phase === 'running' || isPolling;

  const documentStatusLabel = (() => {
    if (phase === 'idle') return 'Idle';
    if (phase === 'starting') return 'Starting…';
    if (phase === 'running') return status?.status ?? 'Running…';
    if (phase === 'completed') return status?.status ?? 'Completed';
    if (phase === 'failed') return status?.status ?? 'Failed';
    return 'Unknown';
  })();

  const canDownloadTranslatedDocument =
    phase === 'completed' &&
    status?.succeeded &&
    !!startResponse?.target_sas_url;

  const modalContent = (
    <>
      {/* Language selection (shared for text + document) */}
      <div className="flex flex-col md:flex-row items-center space-y-4 md:space-y-0 md:space-x-4">
        <div className="w-full">
          <label
            htmlFor="source-language"
            className="block text-sm font-medium text-gray-700 dark:text-gray-200"
          >
            {t('translatorSourceLanguageLabel')}
          </label>
          <select
            id="source-language"
            className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
            value={sourceLanguage}
            onChange={(e) => setSourceLanguage(e.target.value)}
          >
            <option value="" className="text-gray-400 dark:text-gray-400">
              {t('translatorEmptyFromLanguage')}
            </option>
            {languages.map((language) => (
              <option key={language.value} value={language.value}>
                {language.label} ({language.autonym})
              </option>
            ))}
          </select>
        </div>
        <button
          id="translate-language-swap"
          onClick={() => {
            const temp = sourceLanguage;
            setSourceLanguage(targetLanguage);
            setTargetLanguage(temp);
          }}
          className="hidden md:flex items-center justify-center px-3 py-2 mt-6 md:mt-0 rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 7h16M4 7l4-4M4 7l4 4M20 17H4M20 17l-4-4M20 17l-4 4"
            />
          </svg>
          <span className="sr-only">Swap languages</span>
        </button>
        <div className="w-full">
          <label
            htmlFor="target-language"
            className="block text-sm font-medium text-gray-700 dark:text-gray-200"
          >
            {t('translatorTargetLanguageLabel')}
          </label>
          {useTargetLanguageDropdown ? (
            <select
              id="target-language"
              className="mt-2 block w-full pl-3 pr-10 py-2 text-base border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
            >
              <option value="" className="text-gray-400 dark:text-gray-400">
                {t('translatorEmptyToLanguage')}
              </option>
              {languages.map((language) => (
                <option key={language.value} value={language.value}>
                  {language.label} ({language.autonym})
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              placeholder="Type a language"
              className="mt-2 block w-full pl-3 pr-10 py-2 text-base border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
            />
          )}
        </div>
      </div>

      {/* TEXT TRANSLATION AREA (existing behavior) */}
      <div className="my-4">
        <label
          htmlFor="input-text"
          className="block text-sm font-medium text-gray-700 dark:text-gray-200"
        >
          {t('translatorTextToTranslateLabel')}
        </label>
        <textarea
          id="input-text"
          ref={inputTextRef}
          rows={6}
          className="mt-1 block w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 text-black dark:text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
          placeholder={t('translatorTextToTranslatePlaceholder')}
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
        ></textarea>
      </div>

      {/* Advanced options (still for text prompt) */}
      <div className="my-4">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="flex items-center text-sm font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-500"
        >
          {t('advancedOptionsButton')}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className={`h-5 w-5 ml-1 transform ${
              showAdvanced ? 'rotate-180' : ''
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 9l-7 7-7-7"
            />
          </svg>
        </button>
        {showAdvanced && (
          <div className="mt-2 p-4 border border-gray-300 dark:border-gray-600 rounded-md">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="translation-type"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-200"
                >
                  {t('translatorTranslationTypeLabel')}
                </label>
                <select
                  id="translation-type"
                  className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
                  value={translationType}
                  onChange={(e) => setTranslationType(e.target.value)}
                >
                  <option value="literal">
                    {t('translatorTranslationTypeLiteral')}
                  </option>
                  <option value="balanced">
                    {t('translatorTranslationTypeBalanced')}
                  </option>
                  <option value="figurative">
                    {t('translatorTranslationTypeFigurative')}
                  </option>
                  <option value="cultural">
                    {t('translatorTranslationTypeCultural')}
                  </option>
                </select>
              </div>
              <div>
                <label
                  htmlFor="domain-specific"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-200"
                >
                  {t('translatorTranslationDomainLabel')}
                </label>
                <select
                  id="domain-specific"
                  className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm rounded-md"
                  value={domainSpecific}
                  onChange={(e) => setDomainSpecific(e.target.value)}
                >
                  <option value="general">
                    {t('translatorTranslationDomainGeneral')}
                  </option>
                  <option value="medical">
                    {t('translatorTranslationDomainMedical')}
                  </option>
                  <option value="legal">
                    {t('translatorTranslationDomainLegal')}
                  </option>
                  <option value="technical">
                    {t('translatorTranslationDomainTechnical')}
                  </option>
                  <option value="business">
                    {t('translatorTranslationDomainBusiness')}
                  </option>
                </select>
              </div>
            </div>
            <div className="flex flex-col md:flex-row md:items-center md:space-x-6 space-y-4 md:space-y-0 mt-4">
              <div className="flex items-center">
                <input
                  id="use-formal-language"
                  type="checkbox"
                  checked={useFormalLanguage}
                  onChange={(e) => setUseFormalLanguage(e.target.checked)}
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded"
                />
                <label
                  htmlFor="use-formal-language"
                  className="ml-2 block text-sm text-gray-700 dark:text-gray-200"
                >
                  {t('translatorFormalLanguageLabel')}
                </label>
              </div>
              <div className="flex items-center">
                <input
                  id="use-gender-neutral-language"
                  type="checkbox"
                  checked={useGenderNeutralLanguage}
                  onChange={(e) =>
                    setUseGenderNeutralLanguage(e.target.checked)
                  }
                  className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded"
                />
                <label
                  htmlFor="use-gender-neutral-language"
                  className="ml-2 block text-sm text-gray-700 dark:text-gray-200"
                >
                  {t('translatorGenderNeutralLabel')}
                </label>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Auto-submit toggle (still for text prompt) */}
      <div className="flex items-center mt-4 mb-6">
        <input
          id="auto-submit"
          type="checkbox"
          checked={autoSubmit}
          onChange={(e) => setAutoSubmit(e.target.checked)}
          className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded"
        />
        <label
          htmlFor="auto-submit"
          className="ml-2 block text-sm text-gray-700 dark:text-gray-200"
        >
          {t('autoSubmitButton')}
        </label>
      </div>

      {/* DOCUMENT TRANSLATION SECTION */}
      <div className="mt-6 border-t border-gray-300 dark:border-gray-700 pt-4">
        <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2">
          Document translation
        </h4>

        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Upload a document to translate it between the selected languages.
        </p>

        <div className="flex flex-col gap-3">
          <div>
            <label
              htmlFor="document-file"
              className="block text-sm font-medium text-gray-700 dark:text-gray-200"
            >
              Document file
            </label>
            <input
              id="document-file"
              type="file"
              accept=".pdf,.doc,.docx,.txt,.rtf,.ppt,.pptx"
              className="mt-1 block w-full text-sm text-gray-900 dark:text-gray-100 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border file:border-gray-300 dark:file:border-gray-600 file:text-sm file:font-semibold file:bg-gray-50 dark:file:bg-gray-700 file:text-gray-700 dark:file:text-gray-200 hover:file:bg-gray-100 dark:hover:file:bg-gray-600"
              onChange={(e) => {
                const file = e.target.files?.[0];
                setDocumentFile(file ?? null);
              }}
            />
            {documentFile && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Selected: <span className="font-medium">{documentFile.name}</span>
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 mt-2">
            <button
              type="button"
              onClick={handleStartDocumentTranslation}
              disabled={isDocumentBusy}
              className={`flex-1 inline-flex justify-center py-2 px-4 text-sm font-medium rounded-md border ${
                isDocumentBusy
                  ? 'bg-gray-200 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-300 dark:border-gray-700 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white border-transparent'
              }`}
            >
              {isDocumentBusy ? 'Translating…' : 'Start document translation'}
            </button>

            {canDownloadTranslatedDocument && startResponse?.target_sas_url && (
              <a
                href={startResponse.target_sas_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center px-3 py-2 text-xs font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Download translated document
              </a>
            )}
          </div>

          {/* Status + errors */}
          <div className="mt-2 text-xs text-gray-600 dark:text-gray-300 space-y-1">
            <div>
              <span className="font-medium">Status:</span>{' '}
              <span>{documentStatusLabel}</span>
            </div>
            {jobId && (
              <div className="text-[11px] text-gray-500 dark:text-gray-400">
                Job ID: <code className="break-all">{jobId}</code>
              </div>
            )}
            {documentError && (
              <div className="text-[11px] text-red-500 dark:text-red-400">
                {documentError}
              </div>
            )}
            {status?.error && (
              <div className="text-[11px] text-red-500 dark:text-red-400">
                {status.error}
              </div>
            )}
            {phase === 'completed' && status?.succeeded && (
              <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
                Translation completed. You can download the translated document
                above.
              </div>
            )}
            {phase === 'failed' && (
              <div className="text-[11px] text-red-500 dark:text-red-400">
                Translation failed. Please try again or upload another document.
              </div>
            )}
          </div>

          {isDocumentBusy && (
            <button
              type="button"
              onClick={stopPolling}
              className="self-start mt-1 text-[11px] text-gray-500 dark:text-gray-400 underline hover:text-gray-700 dark:hover:text-gray-200"
            >
              Stop polling
            </button>
          )}
        </div>
      </div>
    </>
  );

  const modalFooter = (
    <button
      onClick={handleTranslate}
      className="w-full flex justify-center py-3 px-4 text-base font-medium text-black p-2 border rounded-lg shadow border-neutral-500 text-neutral-900 hover:bg-neutral-100 focus:outline-none dark:border-neutral-800 dark:border-opacity-50 dark:bg-white dark:hover:bg-neutral-300"
    >
      {autoSubmit ? t('translatorTranslateButton') : t('generatePromptButton')}
    </button>
  );

  return (
    <>
      <button
        style={{ display: 'none' }}
        onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
          event.preventDefault();
          setIsModalOpen(true);
        }}
        ref={openModalButtonRef}
      >
        <IconLanguage className="text-black dark:text-white rounded h-5 w-5 hover:bg-gray-200 dark:hover:bg-gray-700" />
        <span className="sr-only">Translate text</span>
      </button>

      <Modal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={
          <h3 className="text-2xl font-semibold text-gray-800 dark:text-white flex items-center">
            <IconLanguage className="h-8 w-8 mr-2" />
            {t('translatorTitle')}
          </h3>
        }
        size="lg"
        betaBadge={<BetaBadge />}
        initialFocusRef={inputTextRef}
        footer={modalFooter}
        closeWithButton={true}
      >
        {modalContent}
      </Modal>
    </>
  );
};

export default ChatInputTranslate;
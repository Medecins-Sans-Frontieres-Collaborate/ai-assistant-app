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
import useDocumentTranslation from '@/hooks/useDocumentTranslation';
import documentService from '@/services/documentService';
import HomeContext from '@/pages/api/home/home.context';

import BetaBadge from '@/components/Beta/Badge';
import Modal from '@/components/UI/Modal';

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
  const [file, setFile] = useState<File | null>(null);
  const { state: homeState } = React.useContext(HomeContext);
  const { user } = homeState || ({} as any);

  const {
    status: docFlowStatus,
    document: uploadedDocument,
    jobStatus,
    upload: docUpload,
    startTranslation: docStartTranslation,
    download: docDownload,
  } = useDocumentTranslation();
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

  const handleUploadAndTranslate = async () => {
    if (!file) {
      toast.error(t('translatorNoFileError') || 'No file selected');
      return;
    }
    if (!targetLanguage) {
      toast.error(t('translatorNoTargetLanguageError'));
      return;
    }

    try {
      // Upload via hook (wraps documentService)
      const doc = await docUpload(file, file.name, { department: 'translation' });
      toast.success(t('uploaderUploadSuccess') || 'Uploaded');

      const userId = (user && ((user as any).id || (user as any).email)) || 'unknown';

      await docStartTranslation(
        {
          document_id: doc.id,
          user_id: userId,
          source_lang: sourceLanguage || undefined,
          target_lang: targetLanguage,
        },
        (s) => {
          // status updates handled via hook state; give user small notifications
          if (s.status === 'Succeeded') {
            toast.success(t('translatorTranslateComplete') || 'Translation completed');
          }
          if (s.status === 'Failed') {
            toast.error(t('translatorTranslateFailed') || 'Translation failed');
          }
        },
      );
    } catch (err) {
      console.error('Upload/translate flow failed', err);
      toast.error(t('translatorTranslateFailed') || 'Translation failed');
    }
  };

  const handleDownloadTranslated = async () => {
    const blobName = jobStatus?.translated_blob_name;
    if (!blobName) {
      toast.error('No translated file available');
      return;
    }
    try {
      const blob = await documentService.downloadBlob(blobName, false);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = uploadedDocument?.filename || 'translated';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('download failed', e);
      toast.error('Download failed');
    }
  };

  const modalContent = (
    <>
      {/* Document upload & translate section */}
      <div className="mb-4 p-3 border rounded bg-gray-50 dark:bg-gray-800">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
          {t('translatorDocumentUploadTitle', 'Upload document to translate')}
        </label>
        <div className="mt-2 flex items-center space-x-2">
          <input
            type="file"
            onChange={(e) => setFile(e.target.files ? e.target.files[0] : null)}
            className="text-sm"
          />
          <button
            onClick={handleUploadAndTranslate}
            className="py-2 px-3 bg-indigo-600 text-white rounded"
          >
            {t('translatorUploadAndTranslateButton', 'Upload & Translate')}
          </button>
        </div>
        {file && (
          <div className="mt-2 text-sm text-gray-600 dark:text-gray-300">{file.name}</div>
        )}
        <div className="mt-2 text-sm">
          {docFlowStatus && <div>Translation flow: {docFlowStatus}</div>}
          {jobStatus && <div>Job status: {jobStatus.status}</div>}
          {jobStatus?.status === 'Succeeded' && jobStatus.translated_blob_name && (
            <div className="mt-2">
              <button
                onClick={handleDownloadTranslated}
                className="py-1 px-2 bg-green-600 text-white rounded text-sm"
              >
                {t('translatorDownloadButton', 'Download translated file')}
              </button>
            </div>
          )}
        </div>
      </div>
      {/* Language selection */}
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
            <option value="" className={'text-gray-400 dark:text-gray-400'}>
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
          id={'translate-language-swap'}
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
              <option value="" className={'text-gray-400 dark:text-gray-400'}>
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
      {/* Input text area */}
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
      {/* Advanced options */}
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
            {/* Advanced options content */}
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
      {/* Add auto-submit toggle before the Translate button */}
      <div className="flex items-center mt-4">
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

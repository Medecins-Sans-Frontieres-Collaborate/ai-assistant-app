'use client';

import {
  IconAlertTriangle,
  IconBrandOnedrive,
  IconChevronDown,
  IconExternalLink,
  IconFileText,
  IconLanguage,
  IconLoader2,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import React, {
  ChangeEvent,
  FC,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import toast from 'react-hot-toast';

import { useLocale, useTranslations } from 'next-intl';

import {
  DocumentTranslationPendingReference,
  DocumentTranslationReference,
  MAX_DOCUMENT_SIZE,
  MAX_GLOSSARY_SIZE,
  generateTranslatedFilename,
} from '@/types/documentTranslation';
import type { M365DriveEntry } from '@/types/m365';

import M365FilePickerModal from '@/components/Chat/ChatInput/M365FilePickerModal';
import Modal from '@/components/UI/Modal';
import { Tooltip } from '@/components/UI/Tooltip';

import {
  DOCUMENT_TRANSLATION_LANGUAGES,
  getLanguageDisplayName,
  getSecondaryLanguageLabel,
  isOfficiallySupportedDocumentTranslationLanguage,
  searchDocumentTranslationLanguages,
} from '@/lib/constants/documentTranslationLanguages';
import {
  DOCUMENT_TRANSLATION_EXTENSIONS,
  GLOSSARY_ACCEPT_TYPES,
} from '@/lib/constants/fileTypes';

interface ChatInputDocumentTranslateProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Callback to close the modal */
  onClose: () => void;
  /** The document file to translate */
  documentFile: File | null;
  /**
   * §1 third pass: allow picking the source from OneDrive/SharePoint when no
   * local file was chosen. Callers gate on flag + m365Connected.
   */
  allowM365Source?: boolean;
  /** Callback when translation completes successfully */
  onTranslationComplete: (reference: DocumentTranslationReference) => void;
  /**
   * Called instead of onTranslationComplete for ASYNC (batch) jobs — PDFs.
   * The caller writes a pending marker into the conversation; the viewer
   * polls until Azure finishes.
   */
  onTranslationPending?: (pending: DocumentTranslationPendingReference) => void;
}

/**
 * Modal for configuring and initiating document translation.
 *
 * Provides UI for selecting translation options:
 * - Target language (searchable dropdown with 80+ languages)
 * - Optional source language (auto-detect if omitted)
 * - Optional glossary file upload
 * - Custom output filename
 */
const ChatInputDocumentTranslate: FC<ChatInputDocumentTranslateProps> = ({
  isOpen,
  onClose,
  documentFile,
  allowM365Source = false,
  onTranslationComplete,
  onTranslationPending,
}) => {
  const t = useTranslations();
  const locale = useLocale();

  // Form state
  const [targetLanguage, setTargetLanguage] = useState('');
  const [sourceLanguage, setSourceLanguage] = useState('');
  const [glossaryFile, setGlossaryFile] = useState<File | null>(null);
  const [customFilename, setCustomFilename] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);

  // M365 source (mutually exclusive with documentFile — the caller passes
  // one or the other; the picker fills this when no local file was given).
  const [m365Source, setM365Source] = useState<{
    driveId: string;
    itemId: string;
    name: string;
    size?: number;
  } | null>(null);
  const [m365PickerOpen, setM365PickerOpen] = useState(false);
  const sourceName = documentFile?.name ?? m365Source?.name ?? null;

  // UI state
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);

  // Search state for language dropdowns
  const [targetSearch, setTargetSearch] = useState('');
  const [sourceSearch, setSourceSearch] = useState('');
  const [showTargetDropdown, setShowTargetDropdown] = useState(false);
  const [showSourceDropdown, setShowSourceDropdown] = useState(false);

  // Refs
  const targetInputRef = useRef<HTMLInputElement>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const glossaryInputRef = useRef<HTMLInputElement>(null);
  const targetDropdownRef = useRef<HTMLDivElement>(null);
  const sourceDropdownRef = useRef<HTMLDivElement>(null);

  // Filter languages based on search (supports autonym, English, localized name, and ISO code)
  const filteredTargetLanguages = useMemo(() => {
    if (!targetSearch) return DOCUMENT_TRANSLATION_LANGUAGES;
    return searchDocumentTranslationLanguages(targetSearch, locale);
  }, [targetSearch, locale]);

  const filteredSourceLanguages = useMemo(() => {
    if (!sourceSearch) return DOCUMENT_TRANSLATION_LANGUAGES;
    return searchDocumentTranslationLanguages(sourceSearch, locale);
  }, [sourceSearch, locale]);

  // Generate default filename when target language changes
  useEffect(() => {
    if (sourceName && targetLanguage && !customFilename) {
      setCustomFilename(generateTranslatedFilename(sourceName, targetLanguage));
    }
  }, [sourceName, targetLanguage, customFilename]);

  // Reset form when modal opens with new file
  useEffect(() => {
    if (isOpen) {
      setTargetLanguage('');
      setSourceLanguage('');
      setGlossaryFile(null);
      setCustomFilename('');
      setTargetSearch('');
      setSourceSearch('');
      setShowAdvancedOptions(false);
      setM365Source(null);
      // M365-mode open with no file goes straight to the picker.
      setM365PickerOpen(allowM365Source && !documentFile);
    }
  }, [isOpen, documentFile, allowM365Source]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        targetDropdownRef.current &&
        !targetDropdownRef.current.contains(event.target as Node) &&
        targetInputRef.current &&
        !targetInputRef.current.contains(event.target as Node)
      ) {
        setShowTargetDropdown(false);
      }
      if (
        sourceDropdownRef.current &&
        !sourceDropdownRef.current.contains(event.target as Node) &&
        sourceInputRef.current &&
        !sourceInputRef.current.contains(event.target as Node)
      ) {
        setShowSourceDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle glossary file selection
  const handleGlossaryChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (file.size > MAX_GLOSSARY_SIZE) {
        toast.error(
          t('documentTranslation.glossaryTooLarge', {
            maxSize: `${MAX_GLOSSARY_SIZE / 1024 / 1024}MB`,
          }),
        );
        return;
      }

      setGlossaryFile(file);
    },
    [t],
  );

  // Handle translation
  const handleTranslate = useCallback(async () => {
    if (!documentFile && !m365Source) {
      toast.error(t('documentTranslation.noDocumentError'));
      return;
    }

    if (!targetLanguage) {
      toast.error(t('documentTranslation.noTargetLanguageError'));
      return;
    }

    const knownSize = documentFile?.size ?? m365Source?.size;
    if (knownSize !== undefined && knownSize > MAX_DOCUMENT_SIZE) {
      toast.error(
        t('documentTranslation.documentTooLarge', {
          maxSize: `${MAX_DOCUMENT_SIZE / 1024 / 1024}MB`,
        }),
      );
      return;
    }

    setIsTranslating(true);

    try {
      const formData = new FormData();
      if (documentFile) {
        formData.append('document', documentFile);
      } else if (m365Source) {
        // The server fetches the bytes with the caller's delegated token.
        formData.append('driveId', m365Source.driveId);
        formData.append('itemId', m365Source.itemId);
      }
      formData.append('targetLanguage', targetLanguage);

      if (sourceLanguage) {
        formData.append('sourceLanguage', sourceLanguage);
      }

      if (glossaryFile) {
        formData.append('glossary', glossaryFile);
      }

      if (customFilename) {
        formData.append('customOutputFilename', customFilename);
      }

      const response = await fetch('/api/document-translation/translate', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Translation failed');
      }

      if (result.success && result.data) {
        if (result.data.async) {
          // Batch (PDF) path: the job runs in Azure; the conversation gets a
          // pending card that polls until done.
          toast.success(t('documentTranslation.translationSubmitted'));
          onTranslationPending?.(
            result.data as DocumentTranslationPendingReference,
          );
        } else {
          toast.success(t('documentTranslation.translationSuccess'));
          onTranslationComplete(result.data as DocumentTranslationReference);
        }
        onClose();
      } else {
        throw new Error(result.error || 'Translation failed');
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      toast.error(
        t('documentTranslation.translationFailed', { error: errorMessage }),
      );
      console.error('[DocumentTranslation] Error:', error);
    } finally {
      setIsTranslating(false);
    }
  }, [
    documentFile,
    m365Source,
    targetLanguage,
    sourceLanguage,
    glossaryFile,
    customFilename,
    onTranslationComplete,
    onTranslationPending,
    onClose,
    t,
  ]);

  // Select target language
  const selectTargetLanguage = useCallback(
    (code: string) => {
      setTargetLanguage(code);
      setTargetSearch(getLanguageDisplayName(code, locale));
      setShowTargetDropdown(false);
    },
    [locale],
  );

  // Select source language
  const selectSourceLanguage = useCallback(
    (code: string) => {
      setSourceLanguage(code);
      setSourceSearch(getLanguageDisplayName(code, locale));
      setShowSourceDropdown(false);
    },
    [locale],
  );

  // Clear source language
  const clearSourceLanguage = useCallback(() => {
    setSourceLanguage('');
    setSourceSearch('');
  }, []);

  const modalContent = (
    <div className="space-y-6">
      {/* Document info */}
      {documentFile ? (
        <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <IconFileText size={24} className="text-blue-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
              {documentFile.name}
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {(documentFile.size / 1024).toFixed(1)} KB
            </p>
          </div>
        </div>
      ) : m365Source ? (
        <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
          <IconBrandOnedrive
            size={24}
            className="text-blue-500 flex-shrink-0"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
              {m365Source.name}
            </p>
            {m365Source.size !== undefined && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {(m365Source.size / 1024).toFixed(1)} KB
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => setM365PickerOpen(true)}
            className="flex-shrink-0 rounded-md border border-neutral-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100 dark:border-neutral-600 dark:text-gray-300 dark:hover:bg-neutral-700"
          >
            {t('documentTranslation.changeM365File')}
          </button>
        </div>
      ) : allowM365Source ? (
        <button
          type="button"
          onClick={() => setM365PickerOpen(true)}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-gray-300 p-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <IconBrandOnedrive size={20} className="text-blue-500" />
          {t('documentTranslation.pickFromOneDrive')}
        </button>
      ) : null}

      {/* Target language (required) */}
      <div className="relative">
        <label
          htmlFor="target-language"
          className="flex items-center gap-2 text-sm font-semibold mb-2 text-gray-900 dark:text-white"
        >
          <span>{t('documentTranslation.targetLanguage')} *</span>
          {targetLanguage &&
            !isOfficiallySupportedDocumentTranslationLanguage(
              targetLanguage,
            ) && (
              <Tooltip
                content={t('documentTranslation.unofficialLanguageWarning')}
                position="right"
                multiline
              >
                <IconAlertTriangle
                  size={16}
                  className="text-amber-500 dark:text-amber-400"
                  aria-label={t('documentTranslation.unofficialBadgeLabel')}
                />
              </Tooltip>
            )}
        </label>
        <div className="relative">
          <input
            ref={targetInputRef}
            id="target-language"
            type="text"
            value={targetSearch}
            onChange={(e) => {
              setTargetSearch(e.target.value);
              setShowTargetDropdown(true);
              if (!e.target.value) setTargetLanguage('');
            }}
            onFocus={() => setShowTargetDropdown(true)}
            placeholder={t('documentTranslation.searchLanguage')}
            className="w-full pl-10 pr-4 py-3 text-base bg-white dark:bg-surface-dark-input border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent rounded-lg transition-all"
          />
          <IconLanguage
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
        </div>
        {showTargetDropdown && (
          <div
            ref={targetDropdownRef}
            className="absolute z-50 w-full mt-1 max-h-60 overflow-auto bg-white dark:bg-surface-dark-input border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg"
          >
            {filteredTargetLanguages.length === 0 ? (
              <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                {t('documentTranslation.noLanguagesFound')}
              </div>
            ) : (
              filteredTargetLanguages.map((lang) => {
                const secondaryLabel = getSecondaryLanguageLabel(lang, locale);
                return (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => selectTargetLanguage(lang.code)}
                    className={`w-full flex items-center gap-2 text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
                      targetLanguage === lang.code
                        ? 'bg-blue-50 dark:bg-blue-900/20'
                        : ''
                    }`}
                  >
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {lang.nativeName}
                    </span>
                    {secondaryLabel && (
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        ({secondaryLabel})
                      </span>
                    )}
                    {!lang.officiallySupported && (
                      <IconAlertTriangle
                        size={14}
                        className="ml-auto text-amber-500 dark:text-amber-400 flex-shrink-0"
                        aria-label={t(
                          'documentTranslation.unofficialBadgeLabel',
                        )}
                      />
                    )}
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* Advanced options (collapsible) */}
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setShowAdvancedOptions(!showAdvancedOptions)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
        >
          <span>{t('documentTranslation.advancedOptions')}</span>
          <IconChevronDown
            size={18}
            className={`transition-transform duration-200 ${showAdvancedOptions ? 'rotate-180' : ''}`}
          />
        </button>

        {showAdvancedOptions && (
          <div className="p-4 space-y-5 border-t border-gray-200 dark:border-gray-700">
            {/* Source language (optional) */}
            <div className="relative">
              <label
                htmlFor="source-language"
                className="flex items-center gap-2 text-sm font-medium mb-2 text-gray-700 dark:text-gray-300"
              >
                <span>
                  {t('documentTranslation.sourceLanguage')}
                  <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                    ({t('documentTranslation.autoDetect')})
                  </span>
                </span>
                {sourceLanguage &&
                  !isOfficiallySupportedDocumentTranslationLanguage(
                    sourceLanguage,
                  ) && (
                    <Tooltip
                      content={t(
                        'documentTranslation.unofficialLanguageWarning',
                      )}
                      position="right"
                      multiline
                    >
                      <IconAlertTriangle
                        size={16}
                        className="text-amber-500 dark:text-amber-400"
                        aria-label={t(
                          'documentTranslation.unofficialBadgeLabel',
                        )}
                      />
                    </Tooltip>
                  )}
              </label>
              <div className="relative">
                <input
                  ref={sourceInputRef}
                  id="source-language"
                  type="text"
                  value={sourceSearch}
                  onChange={(e) => {
                    setSourceSearch(e.target.value);
                    setShowSourceDropdown(true);
                    if (!e.target.value) setSourceLanguage('');
                  }}
                  onFocus={() => setShowSourceDropdown(true)}
                  placeholder={t('documentTranslation.searchLanguage')}
                  className="w-full pl-10 pr-10 py-2.5 text-sm bg-white dark:bg-surface-dark-input border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent rounded-lg transition-all"
                />
                <IconLanguage
                  size={16}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                />
                {sourceLanguage && (
                  <button
                    type="button"
                    onClick={clearSourceLanguage}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    <IconX size={14} />
                  </button>
                )}
              </div>
              {showSourceDropdown && (
                <div
                  ref={sourceDropdownRef}
                  className="absolute z-50 w-full mt-1 max-h-48 overflow-auto bg-white dark:bg-surface-dark-input border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg"
                >
                  {filteredSourceLanguages.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {t('documentTranslation.noLanguagesFound')}
                    </div>
                  ) : (
                    filteredSourceLanguages.map((lang) => {
                      const secondaryLabel = getSecondaryLanguageLabel(
                        lang,
                        locale,
                      );
                      return (
                        <button
                          key={lang.code}
                          type="button"
                          onClick={() => selectSourceLanguage(lang.code)}
                          className={`w-full flex items-center gap-2 text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
                            sourceLanguage === lang.code
                              ? 'bg-blue-50 dark:bg-blue-900/20'
                              : ''
                          }`}
                        >
                          <span className="text-sm font-medium text-gray-900 dark:text-white">
                            {lang.nativeName}
                          </span>
                          {secondaryLabel && (
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                              ({secondaryLabel})
                            </span>
                          )}
                          {!lang.officiallySupported && (
                            <IconAlertTriangle
                              size={14}
                              className="ml-auto text-amber-500 dark:text-amber-400 flex-shrink-0"
                              aria-label={t(
                                'documentTranslation.unofficialBadgeLabel',
                              )}
                            />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            {/* Glossary file (optional) */}
            <div>
              <label className="block text-sm font-medium mb-1 text-gray-700 dark:text-gray-300">
                {t('documentTranslation.glossary')}
              </label>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                {t('documentTranslation.glossaryHelp')}{' '}
                <a
                  href="https://learn.microsoft.com/en-us/azure/ai-services/translator/document-translation/how-to-guides/create-use-glossaries"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-500 hover:text-blue-600 hover:underline"
                >
                  {t('documentTranslation.learnMore')}
                  <IconExternalLink size={12} />
                </a>
              </p>
              <div className="flex items-center gap-3">
                <input
                  ref={glossaryInputRef}
                  type="file"
                  accept={GLOSSARY_ACCEPT_TYPES}
                  onChange={handleGlossaryChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => glossaryInputRef.current?.click()}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
                >
                  <IconUpload size={14} />
                  {t('documentTranslation.uploadGlossary')}
                </button>
                {glossaryFile && (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                    <span className="text-sm text-blue-700 dark:text-blue-300 truncate max-w-[180px]">
                      {glossaryFile.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => setGlossaryFile(null)}
                      className="text-blue-500 hover:text-blue-700 dark:hover:text-blue-300"
                    >
                      <IconX size={14} />
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Custom output filename */}
            <div>
              <label
                htmlFor="output-filename"
                className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300"
              >
                {t('documentTranslation.outputFilename')}
              </label>
              <input
                id="output-filename"
                type="text"
                value={customFilename}
                onChange={(e) => setCustomFilename(e.target.value)}
                placeholder={
                  sourceName && targetLanguage
                    ? generateTranslatedFilename(sourceName, targetLanguage)
                    : t('documentTranslation.outputFilenamePlaceholder')
                }
                className="w-full px-4 py-2.5 text-sm bg-white dark:bg-surface-dark-input border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent rounded-lg transition-all"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const modalFooter = (
    <button
      onClick={handleTranslate}
      disabled={isTranslating || !targetLanguage || !sourceName}
      className={`w-full flex items-center justify-center gap-2 py-3 px-6 text-base font-semibold rounded-lg shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-blue-500 ${
        isTranslating || !targetLanguage || !sourceName
          ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
          : 'bg-blue-600 hover:bg-blue-700 text-white'
      }`}
    >
      {isTranslating ? (
        <>
          <IconLoader2 size={18} className="animate-spin" />
          {t('documentTranslation.translating')}
        </>
      ) : (
        <>
          <IconLanguage size={18} />
          {t('documentTranslation.translateButton')}
        </>
      )}
    </button>
  );

  // Only accepted formats are pickable; folders always navigate.
  const translateExtensions = useMemo(
    () => DOCUMENT_TRANSLATION_EXTENSIONS.map((ext) => ext.replace(/^\./, '')),
    [],
  );

  const handleM365Pick = useCallback((entry: M365DriveEntry) => {
    setM365Source({
      driveId: entry.driveId,
      itemId: entry.itemId,
      name: entry.name,
      ...(entry.size !== undefined && { size: entry.size }),
    });
    setM365PickerOpen(false);
  }, []);

  return (
    <>
      <Modal
        isOpen={isOpen && !m365PickerOpen}
        onClose={onClose}
        size="lg"
        title={t('documentTranslation.title')}
        footer={modalFooter}
        closeWithButton={true}
        className="!z-[100]"
      >
        {modalContent}
      </Modal>
      {/* Hide/restore instead of stacking modals (same rule as the save
          dialog): the translate form disappears while the picker is up. */}
      <M365FilePickerModal
        isOpen={isOpen && m365PickerOpen}
        onClose={() => setM365PickerOpen(false)}
        onPick={handleM365Pick}
        acceptExtensions={translateExtensions}
      />
    </>
  );
};

export default ChatInputDocumentTranslate;

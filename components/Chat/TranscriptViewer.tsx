'use client';

import { IconCopy, IconDownload, IconLanguage } from '@tabler/icons-react';
import { useState } from 'react';

import { useTranslations } from 'next-intl';

import { CitationStreamdown } from '@/components/Markdown/CitationStreamdown';
import { StreamdownWithCodeButtons } from '@/components/Markdown/StreamdownWithCodeButtons';

interface TranscriptViewerProps {
  filename: string;
  transcript: string;
  processedContent?: string;
  onTranslate?: (transcript: string, targetLanguage: string) => void;
}

/**
 * Component for displaying audio/video transcripts with copy/download functionality
 */
export const TranscriptViewer: React.FC<TranscriptViewerProps> = ({
  filename,
  transcript,
  processedContent,
  onTranslate,
}) => {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showLanguageSelector, setShowLanguageSelector] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState('en');

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

  const handleCopy = async () => {
    await navigator.clipboard.writeText(transcript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([transcript], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename.replace(/\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i, '')}_transcript.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleTranslate = () => {
    if (onTranslate) {
      onTranslate(transcript, selectedLanguage);
      setShowLanguageSelector(false);
    }
  };

  // Format transcript with line breaks at sentence boundaries
  const formattedTranscript = transcript
    .replace(/([.!?])\s+/g, '$1\n\n')
    .trim();

  return (
    <div className="transcript-viewer my-4">
      {/* Header */}
      <div className="mb-3">
        {processedContent ? (
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Transcription of{' '}
            <span className="font-medium text-gray-900 dark:text-gray-100">
              {filename}
            </span>
          </div>
        ) : (
          <div className="text-base font-medium text-gray-900 dark:text-gray-100">
            Transcription of {filename}
          </div>
        )}
      </div>

      {/* Processed Content (if provided) */}
      {processedContent && (
        <div className="mb-4 prose dark:prose-invert max-w-none">
          <StreamdownWithCodeButtons>
            <CitationStreamdown
              citations={[]}
              isAnimating={false}
              controls={true}
              shikiTheme={['github-light', 'github-dark']}
            >
              {processedContent}
            </CitationStreamdown>
          </StreamdownWithCodeButtons>
        </div>
      )}

      {/* Transcript Box */}
      <div className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden bg-gray-50 dark:bg-gray-800">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-700 border-b border-gray-300 dark:border-gray-600">
          <div className="text-xs font-medium text-gray-600 dark:text-gray-400">
            {processedContent ? 'Original Transcript' : 'Transcript'}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
              title={t('common.copyToClipboard')}
            >
              <IconCopy size={14} />
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
              title={t('chat.downloadTranscript')}
            >
              <IconDownload size={14} />
              Download
            </button>
            {onTranslate && (
              <div className="relative">
                {!showLanguageSelector ? (
                  <button
                    onClick={() => setShowLanguageSelector(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                    title={t('chat.translateTranscript')}
                  >
                    <IconLanguage size={14} />
                    Translate
                  </button>
                ) : (
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedLanguage}
                      onChange={(e) => setSelectedLanguage(e.target.value)}
                      className="px-2 py-1 text-xs bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {languages.map((language) => (
                        <option key={language.value} value={language.value}>
                          {language.autonym}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleTranslate}
                      className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 rounded transition-colors"
                    >
                      Go
                    </button>
                    <button
                      onClick={() => setShowLanguageSelector(false)}
                      className="px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
            {processedContent && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="ml-2 px-2.5 py-1 text-xs font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
              >
                {expanded ? 'Collapse' : 'Expand'}
              </button>
            )}
          </div>
        </div>

        {/* Transcript Content */}
        {(!processedContent || expanded) && (
          <div
            className={`p-4 font-mono text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap overflow-y-auto ${
              processedContent ? 'max-h-96' : 'max-h-[600px]'
            }`}
          >
            {formattedTranscript}
          </div>
        )}

        {/* Collapsed state hint */}
        {processedContent && !expanded && (
          <div className="p-3 text-center text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800">
            Click &ldquo;Expand&rdquo; to view the original transcript
          </div>
        )}
      </div>
    </div>
  );
};

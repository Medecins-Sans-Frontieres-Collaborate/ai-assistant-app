'use client';

import {
  IconCode,
  IconDownload,
  IconFileText,
  IconX,
} from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';

import { useTranslations } from 'next-intl';

import { useTheme } from '@/client/hooks/ui/useTheme';

import CodeEditor from './CodeEditor';

import { useArtifactStore } from '@/client/stores/artifactStore';

interface CodeArtifactProps {
  onClose: () => void;
  onSwitchToDocument?: () => void;
}

/**
 * CodeArtifact - Claude Artifacts-style code viewer
 *
 * Appears as a split panel when clicking code blocks in chat.
 * Allows viewing and editing code with Monaco editor.
 * User edits update immediately. AI responses can be opened as new artifacts.
 */
export default function CodeArtifact({
  onClose,
  onSwitchToDocument,
}: CodeArtifactProps) {
  const t = useTranslations();
  const theme = useTheme();
  const {
    fileName,
    language,
    modifiedCode,
    downloadFile,
    setFileName,
    setIsEditorOpen,
  } = useArtifactStore();

  const [isEditing, setIsEditing] = useState(false);

  // Track that editor is open
  useEffect(() => {
    setIsEditorOpen(true);
    return () => setIsEditorOpen(false);
  }, [setIsEditorOpen]);

  const handleDownload = () => {
    try {
      downloadFile();
      toast.success(t('artifact.fileDownloaded'));
    } catch (error) {
      toast.error(t('artifact.failedToDownload'));
    }
  };

  return (
    <div className="flex flex-col h-full w-full min-w-0 overflow-hidden">
      {/* Toolbar */}
      <div className="relative flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 flex-shrink-0 min-w-0 overflow-hidden">
        {/* Left: Filename and Language */}
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          {isEditing ? (
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              onBlur={() => setIsEditing(false)}
              onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
              className="text-sm font-medium bg-neutral-100 dark:bg-neutral-900/50 rounded px-2 py-1 border-none focus:outline-none focus:ring-1 focus:ring-blue-500 dark:text-white"
              autoFocus
            />
          ) : (
            <button
              onClick={() => setIsEditing(true)}
              className="text-sm font-medium bg-neutral-100 dark:bg-neutral-900/50 rounded px-2 py-1 hover:bg-neutral-200 dark:hover:bg-neutral-900 transition-colors dark:text-white truncate"
            >
              {fileName}
            </button>
          )}
          <span className="text-xs text-neutral-500 dark:text-neutral-400 flex-shrink-0">
            {language}
          </span>
        </div>

        {/* Right: Action Buttons */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {onSwitchToDocument && (
            <button
              onClick={onSwitchToDocument}
              className="p-2 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
              title={t('artifact.switchToDocumentEditor')}
            >
              <IconFileText size={18} />
            </button>
          )}

          <button
            onClick={handleDownload}
            disabled={!modifiedCode}
            className="p-2 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title={t('artifact.download')}
          >
            <IconDownload size={18} />
          </button>

          <div className="w-px h-5 bg-neutral-300 dark:bg-neutral-700 mx-1" />

          <button
            onClick={onClose}
            className="p-2 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-colors"
            title={t('artifact.close')}
          >
            <IconX size={18} />
          </button>
        </div>
      </div>

      {/* Code Editor */}
      <div className="flex-1 overflow-hidden min-h-0 min-w-0">
        <CodeEditor theme={theme} />
      </div>

      {/* Disclaimer Footer */}
      <div className="px-4 py-2 border-t border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 flex-shrink-0">
        <p className="text-xs text-center text-neutral-500 dark:text-neutral-400">
          {t('artifact.editsNotSaved')}
        </p>
      </div>
    </div>
  );
}

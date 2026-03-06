import {
  IconCheck,
  IconChevronDown,
  IconCode,
  IconInfoCircle,
  IconLoader2,
  IconX,
} from '@tabler/icons-react';
import React, {
  ChangeEvent,
  Dispatch,
  FC,
  MouseEvent,
  SetStateAction,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import { ChatInputSubmitTypes, FilePreview } from '@/types/chat';

import { XIcon } from '@/components/Icons/cancel';
import FileIcon from '@/components/Icons/file';

import { useArtifactStore } from '@/client/stores/artifactStore';
import { TRANSCRIPTION_LANGUAGES } from '@/lib/constants/transcriptionLanguages';

/**
 * Lightbox modal for full-screen image viewing
 */
interface LightboxProps {
  imageUrl: string;
  onClose: () => void;
}

const Lightbox: FC<LightboxProps> = ({ imageUrl, onClose }) => {
  const t = useTranslations();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 text-white hover:text-gray-300 transition-colors"
        onClick={onClose}
        aria-label={t('common.close')}
      >
        <IconX size={32} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt={t('chat.fullSizePreview')}
        className="max-w-[90vw] max-h-[90vh] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
};

interface ChatFileUploadPreviewsProps {
  filePreviews: FilePreview[];
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>;
  uploadProgress?: { [key: string]: number };
  removeFile: (filePreview: FilePreview) => void;
}

interface ChatFileUploadPreviewProps {
  filePreview: FilePreview;
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
  setSubmitType: Dispatch<SetStateAction<ChatInputSubmitTypes>>;
  progress?: number;
  removeFile: (filePreview: FilePreview) => void;
}

/**
 * Helper function to check if a file is a code file based on extension
 */
const isCodeFile = (extension: string): boolean => {
  const codeExtensions = [
    'py',
    'js',
    'jsx',
    'ts',
    'tsx',
    'java',
    'c',
    'cpp',
    'cs',
    'go',
    'rb',
    'php',
    'swift',
    'kt',
    'rs',
    'scala',
    'sh',
    'bash',
    'ps1',
    'r',
    'sql',
    'html',
    'css',
    'scss',
    'sass',
    'less',
    'json',
    'xml',
    'yaml',
    'yml',
    'md',
    'txt',
    'env',
    'config',
    'ini',
    'toml',
  ];
  return codeExtensions.includes(extension.toLowerCase());
};

/**
 * Transcription options component for audio/video files.
 * Allows users to specify language and provide context instructions.
 */
interface TranscriptionOptionsProps {
  filePreview: FilePreview;
  setFilePreviews: Dispatch<SetStateAction<FilePreview[]>>;
}

const TranscriptionOptions: FC<TranscriptionOptionsProps> = ({
  filePreview,
  setFilePreviews,
}) => {
  const t = useTranslations();
  const [showPromptInput, setShowPromptInput] = useState(
    !!filePreview.transcriptionPrompt,
  );

  const updateFilePreview = (updates: Partial<FilePreview>) => {
    setFilePreviews((prevPreviews) =>
      prevPreviews.map((fp) =>
        fp.name === filePreview.name && fp.previewUrl === filePreview.previewUrl
          ? { ...fp, ...updates }
          : fp,
      ),
    );
  };

  const handleLanguageChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    updateFilePreview({
      transcriptionLanguage: value || undefined,
    });
  };

  const handlePromptChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    updateFilePreview({
      transcriptionPrompt: value || undefined,
    });
  };

  const selectedLanguage = TRANSCRIPTION_LANGUAGES.find(
    (lang) => lang.code === filePreview.transcriptionLanguage,
  );
  const selectedLanguageLabel = selectedLanguage
    ? t(selectedLanguage.labelKey)
    : t('transcription.languages.autoDetect');

  return (
    <div className="space-y-1.5">
      {/* Info text */}
      <div className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
        <IconInfoCircle size={12} className="flex-shrink-0" />
        <span>{t('transcription.transcribesOnSend')}</span>
      </div>

      {/* Language selector */}
      <div className="relative">
        <select
          value={filePreview.transcriptionLanguage || ''}
          onChange={handleLanguageChange}
          className="w-full text-xs px-2 py-1 pr-6 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 appearance-none cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
          onClick={(e) => e.stopPropagation()}
        >
          {TRANSCRIPTION_LANGUAGES.map((lang) => (
            <option
              key={lang.code}
              value={lang.code}
              className={
                lang.officiallySupported
                  ? 'text-gray-700 dark:text-gray-200'
                  : 'text-gray-400 dark:text-gray-500'
              }
            >
              {t(lang.labelKey)}
            </option>
          ))}
        </select>
        <IconChevronDown
          size={12}
          className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500"
        />
      </div>

      {/* Prompt toggle/input */}
      {!showPromptInput ? (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowPromptInput(true);
          }}
          className="text-xs text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          + {t('transcription.addInstructions')}
        </button>
      ) : (
        <input
          type="text"
          value={filePreview.transcriptionPrompt || ''}
          onChange={handlePromptChange}
          onClick={(e) => e.stopPropagation()}
          placeholder={t('transcription.instructionsPlaceholder')}
          className="w-full text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
          maxLength={200}
        />
      )}
    </div>
  );
};

const ChatFileUploadPreview: FC<ChatFileUploadPreviewProps> = ({
  filePreview,
  setFilePreviews,
  setSubmitType,
  progress,
  removeFile,
}) => {
  const t = useTranslations();
  const { openArtifact } = useArtifactStore();

  if (!filePreview) {
    throw new Error('Empty filePreview found');
  }

  const [isHovered, setIsHovered] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [isOpeningInEditor, setIsOpeningInEditor] = useState(false);

  const removeFilePreview = (
    event: MouseEvent<HTMLButtonElement>,
    filePreview: FilePreview,
  ) => {
    event.preventDefault();
    // Trigger exit animation
    setIsRemoving(true);
    // Wait for animation to complete before removing from state
    setTimeout(() => {
      removeFile(filePreview);
    }, 200); // Match the animation duration
  };

  const openLightbox = (imageUrl: string) => {
    // Only open lightbox for images, not for audio/video files
    if (
      !filePreview.type.startsWith('audio/') &&
      !filePreview.type.startsWith('video/')
    ) {
      setLightboxImage(imageUrl);
    }
  };

  const openInCodeEditor = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (!filePreview.file) {
      alert(t('fileUpload.fileNotAvailable'));
      return;
    }

    try {
      setIsOpeningInEditor(true);

      // Read file content from local File object
      const text = await filePreview.file.text();

      // Detect language from file extension
      const extension =
        filePreview.name.split('.').pop()?.toLowerCase() || 'txt';
      const languageMap: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        py: 'python',
        java: 'java',
        cs: 'csharp',
        go: 'go',
        rs: 'rust',
        cpp: 'cpp',
        c: 'c',
        html: 'html',
        css: 'css',
        scss: 'scss',
        sass: 'sass',
        less: 'less',
        json: 'json',
        md: 'markdown',
        sql: 'sql',
        sh: 'shell',
        bash: 'shell',
        yml: 'yaml',
        yaml: 'yaml',
        rb: 'ruby',
        php: 'php',
        swift: 'swift',
        kt: 'kotlin',
        scala: 'scala',
        r: 'r',
        txt: 'plaintext',
        xml: 'xml',
        env: 'plaintext',
        config: 'plaintext',
        ini: 'plaintext',
        toml: 'toml',
      };

      const language = languageMap[extension] || 'plaintext';

      // Open in code editor
      openArtifact(text, language, filePreview.name);
    } catch (error) {
      console.error('Error opening file in code editor:', error);
      alert(t('fileUpload.failedToOpenInEditor'));
    } finally {
      setIsOpeningInEditor(false);
    }
  };

  const { name, type, status, previewUrl } = filePreview;
  const isImage = type.startsWith('image/');
  const isAudio = type.startsWith('audio/');
  const isVideo = type.startsWith('video/');
  const showProgress = status === 'uploading' && progress !== undefined;

  let filename = name;

  // Get file extension and type info
  const extension = filename?.split('.').pop()?.toLowerCase() || '';
  const isPdf = extension === 'pdf';

  // File type styling - just for the badge color
  const getFileTypeColor = (ext: string, fileType: string) => {
    if (fileType.startsWith('audio/')) return 'bg-purple-500 text-white';
    if (fileType.startsWith('video/')) return 'bg-pink-500 text-white';

    switch (ext) {
      // Documents
      case 'pdf':
        return 'bg-red-500 text-white';
      case 'doc':
      case 'docx':
        return 'bg-blue-500 text-white';
      case 'xls':
      case 'xlsx':
        return 'bg-green-500 text-white';
      case 'ppt':
      case 'pptx':
        return 'bg-orange-500 text-white';

      // Text
      case 'txt':
      case 'md':
        return 'bg-gray-500 text-white';

      // Data
      case 'csv':
        return 'bg-emerald-500 text-white';
      case 'json':
        return 'bg-yellow-500 text-white';
      case 'xml':
        return 'bg-amber-600 text-white';
      case 'yaml':
      case 'yml':
        return 'bg-violet-500 text-white';

      // Code - Programming Languages
      case 'py':
        return 'bg-blue-600 text-white';
      case 'js':
      case 'jsx':
        return 'bg-yellow-400 text-black';
      case 'ts':
      case 'tsx':
        return 'bg-blue-500 text-white';
      case 'java':
        return 'bg-red-600 text-white';
      case 'c':
      case 'cpp':
      case 'cs':
        return 'bg-purple-600 text-white';
      case 'go':
        return 'bg-cyan-500 text-white';
      case 'rb':
        return 'bg-red-500 text-white';
      case 'php':
        return 'bg-indigo-500 text-white';
      case 'swift':
        return 'bg-orange-600 text-white';
      case 'kt':
        return 'bg-purple-500 text-white';
      case 'rs':
        return 'bg-orange-700 text-white';
      case 'scala':
        return 'bg-red-700 text-white';

      // Scripts & Config
      case 'sql':
        return 'bg-blue-700 text-white';
      case 'sh':
      case 'bash':
        return 'bg-gray-700 text-white';
      case 'ps1':
        return 'bg-blue-800 text-white';
      case 'r':
        return 'bg-blue-400 text-white';
      case 'env':
      case 'config':
      case 'ini':
      case 'toml':
        return 'bg-slate-600 text-white';

      default:
        return 'bg-gray-500 text-white';
    }
  };

  const badgeColor = getFileTypeColor(extension, type);
  const badgeText = isAudio ? '🎵' : isVideo ? '🎬' : extension.toUpperCase();

  // Determine if the filename is long
  const isLongFilename = filename && filename.length > 16;
  // Apply auto-scrolling animation for long filenames
  const textClassName = isLongFilename ? 'animate-scroll-text-auto' : '';

  return (
    <>
      <style jsx>{`
        @keyframes slideInScale {
          0% {
            opacity: 0;
            transform: translateY(10px) scale(0.95);
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
      {/* Render lightbox if image is selected */}
      {lightboxImage && (
        <Lightbox
          imageUrl={lightboxImage}
          onClose={() => setLightboxImage(null)}
        />
      )}

      <div
        className={`relative rounded-lg overflow-hidden bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-900 group transition-all duration-200 ease-out ${
          isRemoving
            ? 'opacity-0 scale-90 translate-x-2 translate-y-2'
            : 'opacity-100 scale-100 translate-x-0 translate-y-0'
        } hover:scale-[1.02] hover:shadow-lg ${isImage ? 'h-[150px]' : 'min-h-[90px]'}`}
        style={{
          width: 'calc(50% - 0.25rem)',
          maxWidth: '280px',
          minWidth: '200px',
          animation: isRemoving ? 'none' : 'slideInScale 0.3s ease-out',
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        onTouchStart={() => setIsHovered(true)}
        onTouchEnd={() => setTimeout(() => setIsHovered(false), 3000)}
      >
        {isImage ? (
          <div className="relative w-full h-full">
            {previewUrl ? (
              <>
                <div
                  className="w-full h-full cursor-pointer hover:opacity-90 transition-opacity"
                  style={{
                    backgroundImage: `url(${previewUrl})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }}
                  onClick={() => openLightbox(previewUrl)}
                />
                {/* Shimmer overlay during upload */}
                {status === 'uploading' && (
                  <div className="absolute inset-0 pointer-events-none">
                    <div
                      className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"
                      style={{
                        backgroundSize: '200% 100%',
                      }}
                    />
                    <div className="absolute inset-0 bg-black/20" />
                  </div>
                )}
              </>
            ) : (
              <div className="w-full h-full relative overflow-hidden bg-gray-200 dark:bg-gray-700">
                {/* Skeleton shimmer for loading preview */}
                <div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 dark:via-white/10 to-transparent animate-shimmer"
                  style={{
                    backgroundSize: '200% 100%',
                  }}
                />
                <span className="sr-only">Loading preview...</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg h-full justify-between">
            <div className="flex items-center gap-2 mb-2">
              <div
                className={`px-2 py-1 rounded text-xs font-bold ${badgeColor} flex-shrink-0`}
              >
                {badgeText}
              </div>
              {status === 'uploading' && progress !== undefined && (
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <IconLoader2
                    size={14}
                    className="animate-spin text-blue-500"
                  />
                  <span className="text-xs font-semibold text-gray-600 dark:text-gray-400">
                    {Math.round(progress)}%
                  </span>
                </div>
              )}
            </div>
            <div className="min-w-0 flex-grow">
              <div
                className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate"
                title={filename}
              >
                {filename}
              </div>
              {/* Upload progress bar */}
              {status === 'uploading' && progress !== undefined && (
                <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mt-1.5">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-300 ease-out bg-[length:1rem_1rem] bg-gradient-to-r from-blue-500 via-blue-400 to-blue-500 animate-progress-bar-stripes"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              )}
            </div>
            <div className="mt-1.5">
              {/* Extraction status for video files */}
              {status === 'extracting' && (
                <div className="flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400">
                  <IconLoader2
                    size={12}
                    className="flex-shrink-0 animate-spin"
                  />
                  <span>{t('fileUpload.extractingAudio')}</span>
                </div>
              )}
              {/* Transcription status indicators */}
              {filePreview.transcriptionStatus === 'pending' && (
                <div className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
                  <IconLoader2
                    size={12}
                    className="flex-shrink-0 animate-spin"
                  />
                  <span>{t('fileUpload.queuedForTranscription')}</span>
                </div>
              )}
              {filePreview.transcriptionStatus === 'processing' && (
                <div className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
                  <IconLoader2
                    size={12}
                    className="flex-shrink-0 animate-spin"
                  />
                  <span>{t('fileUpload.transcribing')}</span>
                </div>
              )}
              {filePreview.transcriptionStatus === 'completed' && (
                <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <IconCheck size={12} className="flex-shrink-0" />
                  <span>{t('fileUpload.transcribed')}</span>
                </div>
              )}
              {filePreview.transcriptionStatus === 'failed' && (
                <div className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                  <IconX size={12} className="flex-shrink-0" />
                  <span>{t('fileUpload.transcriptionFailed')}</span>
                </div>
              )}
              {/* Extracted from video indicator */}
              {filePreview.extractedFromVideo && status === 'completed' && (
                <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                  <IconCheck size={12} className="flex-shrink-0" />
                  <span>
                    {t('fileUpload.extractedFromSmaller', {
                      percent: (
                        (1 -
                          filePreview.extractedFromVideo.extractedSize /
                            filePreview.extractedFromVideo.originalSize) *
                        100
                      ).toFixed(0),
                    })}
                  </span>
                </div>
              )}
              {isPdf && status === 'completed' && (
                <div className="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400">
                  <IconInfoCircle size={12} className="flex-shrink-0" />
                  <span>{t('fileUpload.textExtraction')}</span>
                </div>
              )}
              {(isAudio || isVideo) &&
                status === 'completed' &&
                !filePreview.transcriptionStatus && (
                  <TranscriptionOptions
                    filePreview={filePreview}
                    setFilePreviews={setFilePreviews}
                  />
                )}
              {isCodeFile(extension) && filePreview.file && (
                <button
                  onClick={openInCodeEditor}
                  disabled={isOpeningInEditor}
                  className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={t('fileUpload.openInEditor')}
                >
                  <IconCode
                    size={12}
                    className={isOpeningInEditor ? 'animate-pulse' : ''}
                  />
                  <span>
                    {isOpeningInEditor
                      ? t('fileUpload.opening')
                      : t('fileUpload.openInEditor')}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Remove button */}
        <button
          className={`absolute top-2 right-2 z-10 rounded-full bg-white dark:bg-gray-800 shadow-lg ${
            isHovered ? 'opacity-100' : 'opacity-0 md:group-hover:opacity-100'
          } transition-all duration-200 hover:scale-110 hover:rotate-90 hover:bg-red-50 dark:hover:bg-red-900/30 active:scale-95`}
          onClick={(event) => removeFilePreview(event, filePreview)}
          aria-label={t('common.remove')}
        >
          <XIcon className="w-5 h-5 text-gray-700 dark:text-gray-300 transition-colors hover:text-red-600 dark:hover:text-red-400" />
          <span className="sr-only">{t('common.remove')}</span>
        </button>

        {/* Status indicator */}
        {status === 'failed' && (
          <div className="absolute inset-0 bg-red-500/10 backdrop-blur-sm flex items-center justify-center pointer-events-none">
            <span className="text-red-600 dark:text-red-400 text-sm font-medium">
              {t('fileUpload.failedToUpload')}
            </span>
          </div>
        )}
      </div>
    </>
  );
};

const ChatFileUploadPreviews: FC<ChatFileUploadPreviewsProps> = ({
  filePreviews,
  setFilePreviews,
  setSubmitType,
  uploadProgress,
  removeFile,
}) => {
  const t = useTranslations();

  if (filePreviews.length === 0) {
    return null;
  }

  return (
    <div className="max-w-3xl mx-auto px-2 sm:px-4 pt-2 bg-white dark:bg-[#212121]">
      <div className="mb-1.5">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {filePreviews.length}{' '}
          {filePreviews.length === 1
            ? t('fileUpload.attachment')
            : t('fileUpload.attachments')}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 mb-2">
        {filePreviews.map((filePreview, index) => (
          <ChatFileUploadPreview
            key={`${filePreview}-${index}`}
            filePreview={filePreview}
            setFilePreviews={setFilePreviews}
            setSubmitType={setSubmitType}
            progress={uploadProgress?.[filePreview.name]}
            removeFile={removeFile}
          />
        ))}
      </div>
    </div>
  );
};

export default ChatFileUploadPreviews;

import { IconCode, IconDownload, IconFileText } from '@tabler/icons-react';
import React, { FC, useEffect, useState } from 'react';

import { useTranslations } from 'next-intl';

import { fetchImageBase64FromMessageContent } from '@/lib/services/imageService';

import {
  autoConvertToHtml,
  detectFormat,
} from '@/lib/utils/shared/document/formatConverter';

import { FileMessageContent, ImageMessageContent } from '@/types/chat';

import FileIcon from '@/components/Icons/file';
import ImageIcon from '@/components/Icons/image';

import { useArtifactStore } from '@/client/stores/artifactStore';

/**
 * Component to display image files
 */
const FileImagePreview: FC<{ image: ImageMessageContent }> = ({ image }) => {
  const t = useTranslations();
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<boolean>(false);

  useEffect(() => {
    setTimeout(() => {
      setIsLoading(true);
      setLoadError(false);

      fetchImageBase64FromMessageContent(image)
        .then((imageBase64String) => {
          if (imageBase64String.length > 0) {
            setImageSrc(imageBase64String);
          } else {
            setLoadError(true);
          }
        })
        .catch(() => {
          setLoadError(true);
        })
        .finally(() => {
          setIsLoading(false);
        });
    }, 0);
  }, [image]);

  const handleImageClick = () => {
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
  };

  return (
    <>
      <div
        className="relative rounded-lg overflow-hidden border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 hover:shadow-lg transition-shadow cursor-pointer group"
        style={{
          width: 'calc(50% - 0.25rem)',
          maxWidth: '280px',
          minWidth: '200px',
          height: '150px',
        }}
        onClick={imageSrc ? handleImageClick : undefined}
      >
        {isLoading ? (
          <div className="w-full h-full bg-gray-200 dark:bg-gray-700 animate-shimmer">
            <span className="sr-only">{t('chat.loadingImage')}</span>
          </div>
        ) : loadError ? (
          <div className="flex items-center justify-center w-full h-full text-red-500 text-sm p-3">
            <span>{t('chat.failedToLoadImage')}</span>
          </div>
        ) : imageSrc ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageSrc}
              alt={t('chat.imageContent')}
              className="w-full h-full object-cover"
              onLoad={() => setIsLoading(false)}
            />
            {/* Overlay with badge and download icon */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-bold bg-purple-500 text-white">
                IMG
              </div>
              <div className="absolute top-2 right-2 p-1.5 rounded-full bg-white/90 dark:bg-gray-800/90">
                <IconDownload className="w-4 h-4 text-gray-700 dark:text-gray-300" />
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center w-full h-full p-3">
            <span className="text-sm text-gray-900 dark:text-gray-100 text-center break-words">
              {image.image_url.url.split('/').pop()}
            </span>
          </div>
        )}
      </div>

      {isModalOpen && imageSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
          onClick={handleCloseModal}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageSrc}
            alt={t('chat.fullSizePreview')}
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
};

/**
 * Props for FileContent component
 */
interface FileContentProps {
  files: FileMessageContent[];
  images: ImageMessageContent[];
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
 * Helper function to check if a file is a document file (can be opened in document editor)
 */
const isDocumentFile = (extension: string): boolean => {
  const documentExtensions = ['md', 'markdown', 'txt', 'html', 'htm', 'pdf'];
  return documentExtensions.includes(extension.toLowerCase());
};

/**
 * FileContent Component
 *
 * Renders file attachments with download functionality and image previews.
 */
export const FileContent: FC<FileContentProps> = ({ files, images }) => {
  const t = useTranslations();
  const { openArtifact, openDocument } = useArtifactStore();
  const [isLoadingFile, setIsLoadingFile] = useState<string | null>(null);

  const downloadFile = (event: React.MouseEvent, fileUrl: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (fileUrl) {
      const filename = fileUrl.split('/').pop();
      const downloadUrl = `/api/file/${filename}`;
      window.open(downloadUrl, '_blank');
    }
  };

  const openInCodeEditor = async (
    event: React.MouseEvent,
    fileUrl: string,
    filename: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      setIsLoadingFile(fileUrl);
      const fileId = fileUrl.split('/').pop();
      const response = await fetch(`/api/file/${fileId}`);

      if (!response.ok) {
        throw new Error('Failed to fetch file content');
      }

      const blob = await response.blob();
      const text = await blob.text();

      // Detect language from file extension
      const extension = filename.split('.').pop()?.toLowerCase() || 'txt';
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
      };

      const language = languageMap[extension] || 'plaintext';

      // Open in code editor
      openArtifact(text, language, filename);
    } catch (error) {
      console.error('Error opening file in code editor:', error);
      alert(t('chat.failedToOpenCodeEditor'));
    } finally {
      setIsLoadingFile(null);
    }
  };

  const openInDocumentEditor = async (
    event: React.MouseEvent,
    fileUrl: string,
    filename: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      setIsLoadingFile(fileUrl);
      const fileId = fileUrl.split('/').pop();
      const response = await fetch(`/api/file/${fileId}`);

      if (!response.ok) {
        throw new Error('Failed to fetch file content');
      }

      const blob = await response.blob();
      const extension = filename.split('.').pop()?.toLowerCase();

      let content: string;
      let sourceFormat:
        | 'md'
        | 'markdown'
        | 'txt'
        | 'html'
        | 'htm'
        | 'pdf'
        | null = null;

      // Handle PDF files specially (they need ArrayBuffer)
      if (extension === 'pdf') {
        const { pdfToHtml } =
          await import('@/lib/utils/shared/document/formatConverter');
        const arrayBuffer = await blob.arrayBuffer();
        content = await pdfToHtml(arrayBuffer);
        sourceFormat = 'pdf';
      } else {
        const text = await blob.text();
        content = text; // Store original source content

        // Determine source format
        const formatMap: Record<
          string,
          'md' | 'markdown' | 'txt' | 'html' | 'htm'
        > = {
          md: 'md',
          markdown: 'markdown',
          txt: 'txt',
          html: 'html',
          htm: 'htm',
        };
        sourceFormat = extension ? formatMap[extension] || null : null;
      }

      // Open in document editor with source content in document mode
      openDocument(content, sourceFormat, filename, 'document');
    } catch (error) {
      console.error('Error opening file in document editor:', error);
      alert(t('chat.failedToOpenDocEditor'));
    } finally {
      setIsLoadingFile(null);
    }
  };

  return (
    <div className="flex flex-wrap gap-2 w-full py-2">
      {/* Render Images */}
      {images.map((image, index) => (
        <FileImagePreview key={`image-${index}`} image={image} />
      ))}

      {/* Render Files */}
      {files.map((file, index) => {
        const filename =
          file.originalFilename || file.url.split('/').pop() || '';
        const extension = filename.split('.').pop()?.toLowerCase() || '';

        // Check if this is an audio or video file
        const isAudioVideo = [
          'mp3',
          'mp4',
          'mpeg',
          'mpga',
          'm4a',
          'wav',
          'webm',
        ].includes(extension);

        // File type badge color
        const getBadgeColor = (ext: string) => {
          // Audio/video files
          if (isAudioVideo) return 'bg-purple-500 text-white';

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
              return 'bg-yellow-400 text-gray-900 dark:text-yellow-900';
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

        // Determine if filename is long
        const isLongFilename = filename.length > 30;
        const isCode = isCodeFile(extension);
        const isDocument = isDocumentFile(extension);
        const isLoading = isLoadingFile === file.url;

        return (
          <div
            key={`file-${index}`}
            className="relative flex flex-col p-3 rounded-lg border border-gray-300 dark:border-gray-700 hover:shadow-lg hover:border-gray-400 dark:hover:border-gray-600 transition-all bg-white dark:bg-gray-900 group"
            style={{
              width: 'calc(50% - 0.25rem)',
              maxWidth: '280px',
              minWidth: '200px',
              minHeight: isLongFilename ? '90px' : '75px',
            }}
          >
            <div className="flex items-center justify-between gap-2 mb-2">
              <div
                className={`px-2 py-1 rounded text-xs font-bold ${getBadgeColor(extension)} flex-shrink-0`}
              >
                {extension.toUpperCase()}
              </div>
              <div className="flex items-center gap-1">
                {/* Open as Document button (for document files) */}
                {isDocument && (
                  <button
                    onClick={(event) =>
                      openInDocumentEditor(event, file.url, filename)
                    }
                    disabled={isLoading}
                    className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={t('chat.openAsDocument')}
                  >
                    <IconFileText
                      className={`w-4 h-4 ${
                        isLoading
                          ? 'text-gray-400 animate-pulse'
                          : 'text-green-600 dark:text-green-400'
                      }`}
                    />
                  </button>
                )}
                {/* Open in Code Editor button (only for code files) */}
                {isCode && (
                  <button
                    onClick={(event) =>
                      openInCodeEditor(event, file.url, filename)
                    }
                    disabled={isLoading}
                    className="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title={t('chat.openInCodeEditor')}
                  >
                    <IconCode
                      className={`w-4 h-4 ${
                        isLoading
                          ? 'text-gray-400 animate-pulse'
                          : 'text-blue-600 dark:text-blue-400'
                      }`}
                    />
                  </button>
                )}
                {/* Download button */}
                <button
                  onClick={(event) => downloadFile(event, file.url)}
                  className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  title={t('chat.download')}
                >
                  <IconDownload className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                </button>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <span
                className="block text-sm font-medium text-gray-900 dark:text-gray-100 break-words line-clamp-2"
                title={filename}
              >
                {filename}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default FileContent;

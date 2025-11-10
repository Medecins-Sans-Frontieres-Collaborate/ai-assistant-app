import {
  IconCheck,
  IconFile,
  IconFileText,
  IconLoader2,
  IconMusic,
  IconUpload,
  IconVideo,
  IconX,
} from '@tabler/icons-react';
import { FC } from 'react';

export type FileStatus = 'uploading' | 'transcribing' | 'completed' | 'failed';

interface FileUploadSectionProps {
  uploadedFiles: File[];
  fileStatuses: { [fileName: string]: FileStatus };
  isProcessing: boolean;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveFile: (index: number) => void;
  acceptedFileTypes?: string;
  disabled?: boolean;
}

/**
 * Reusable file upload section with status indicators
 * Used in ToneDashboard and PromptDashboard
 */
export const FileUploadSection: FC<FileUploadSectionProps> = ({
  uploadedFiles,
  fileStatuses,
  isProcessing,
  onFileUpload,
  onRemoveFile,
  acceptedFileTypes = 'audio/*,video/*,text/*,.txt,.md,.pdf,.doc,.docx',
  disabled = false,
}) => {
  const getFileIcon = (file: File) => {
    if (file.type.startsWith('audio/')) {
      return <IconMusic size={16} className="text-purple-500 flex-shrink-0" />;
    }
    if (file.type.startsWith('video/')) {
      return <IconVideo size={16} className="text-blue-500 flex-shrink-0" />;
    }
    if (file.type.startsWith('text/') || file.name.endsWith('.txt')) {
      return <IconFileText size={16} className="text-gray-500 flex-shrink-0" />;
    }
    return <IconFile size={16} className="text-gray-500 flex-shrink-0" />;
  };

  const getStatusIndicator = (status: FileStatus) => {
    switch (status) {
      case 'uploading':
        return (
          <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 ml-auto flex-shrink-0">
            <IconLoader2 size={12} className="animate-spin" />
            Uploading...
          </span>
        );
      case 'transcribing':
        return (
          <span className="flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 ml-auto flex-shrink-0">
            <IconLoader2 size={12} className="animate-spin" />
            Transcribing...
          </span>
        );
      case 'completed':
        return (
          <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 ml-auto flex-shrink-0">
            <IconCheck size={12} />
            Complete
          </span>
        );
      case 'failed':
        return (
          <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400 ml-auto flex-shrink-0">
            <IconX size={12} />
            Failed
          </span>
        );
    }
  };

  return (
    <div>
      <label className="block text-sm font-semibold mb-2 text-gray-900 dark:text-white cursor-pointer">
        <div className="flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-[#1a1a1a] px-4 py-8 text-sm text-gray-600 dark:text-gray-400 hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/10 transition-all">
          <IconUpload size={20} />
          <span>Upload files (audio, video, or text)</span>
        </div>
        <input
          type="file"
          multiple
          accept={acceptedFileTypes}
          onChange={onFileUpload}
          className="hidden"
          disabled={disabled || isProcessing}
        />
      </label>

      {uploadedFiles.length > 0 && (
        <div className="space-y-1">
          {uploadedFiles.map((file, index) => {
            const status = fileStatuses[file.name];
            return (
              <div
                key={index}
                className="flex items-center justify-between p-2 bg-white dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-lg"
              >
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {getFileIcon(file)}
                  <span className="text-xs text-gray-700 dark:text-gray-300 truncate">
                    {file.name}
                  </span>
                </div>
                {status && getStatusIndicator(status)}
                <button
                  onClick={() => onRemoveFile(index)}
                  className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors ml-2"
                  disabled={status === 'uploading' || status === 'transcribing'}
                >
                  <IconX size={12} className="text-gray-500" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

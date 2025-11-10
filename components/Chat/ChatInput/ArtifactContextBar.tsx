import { IconCode, IconX } from '@tabler/icons-react';
import { FC } from 'react';

interface ArtifactContextBarProps {
  fileName: string;
  language: string;
  onClose: () => void;
}

/**
 * Context bar that shows which artifact is currently being edited.
 * Appears above the chat input when the code editor is open.
 * Indicates that the artifact context will be sent with the next message.
 */
export const ArtifactContextBar: FC<ArtifactContextBarProps> = ({
  fileName,
  language,
  onClose,
}) => {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-1.5 bg-blue-50 dark:bg-blue-950/30 border-t border-blue-200 dark:border-blue-800/50">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <IconCode
          size={16}
          className="flex-shrink-0 text-blue-600 dark:text-blue-400"
        />
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-xs text-blue-900 dark:text-blue-100 truncate">
            {fileName}
          </span>
          <span className="text-xs text-blue-600/70 dark:text-blue-400/70 flex-shrink-0">
            ({language})
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-xs text-blue-700 dark:text-blue-300">
          File and edits included with message
        </span>
        <button
          onClick={onClose}
          className="p-0.5 rounded hover:bg-blue-200 dark:hover:bg-blue-900/50 text-blue-600 dark:text-blue-400 transition-colors"
          aria-label="Close editor"
          title="Close code editor"
        >
          <IconX size={14} />
        </button>
      </div>
    </div>
  );
};

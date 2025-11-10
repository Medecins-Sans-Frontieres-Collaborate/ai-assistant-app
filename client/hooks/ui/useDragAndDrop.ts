import { useCallback, useState } from 'react';

export interface DragAndDropHandlers {
  isDragOver: boolean;
  handleDragEnter: (e: React.DragEvent<HTMLDivElement>) => void;
  handleDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  handleDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  handleDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}

/**
 * Custom hook for handling drag-and-drop file uploads
 * Extracted from ChatInput to improve reusability
 *
 * @param onFiles - Callback function called when files are dropped
 * @returns Object containing drag state and event handlers
 *
 * @example
 * const { isDragOver, ...handlers } = useDragAndDrop((files) => {
 *   console.log('Files dropped:', files);
 * });
 *
 * <div {...handlers} className={isDragOver ? 'drag-active' : ''}>
 *   Drop files here
 * </div>
 */
export const useDragAndDrop = (
  onFiles: (files: FileList | File[]) => void,
): DragAndDropHandlers => {
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        const files = e.dataTransfer.files;
        onFiles(files);

        // Attempt to clear the data transfer
        try {
          e.dataTransfer.clearData();
        } catch (err) {
          // Some browsers don't allow clearing data
          // This is fine, just ignore the error
        }
      }
    },
    [onFiles],
  );

  return {
    isDragOver,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
};

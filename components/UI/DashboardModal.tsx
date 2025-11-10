import { IconEdit, IconSparkles, IconX } from '@tabler/icons-react';
import { FC, ReactNode, useState } from 'react';

interface DashboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  leftPanel: ReactNode;
  rightPanel: ReactNode;
  footer?: ReactNode;
}

/**
 * Reusable two-panel dashboard modal layout
 * Used by ToneDashboard and PromptDashboard
 */
export const DashboardModal: FC<DashboardModalProps> = ({
  isOpen,
  onClose,
  title,
  subtitle,
  leftPanel,
  rightPanel,
  footer,
}) => {
  const [mobileActivePanel, setMobileActivePanel] = useState<'form' | 'ai'>(
    'form',
  );

  if (!isOpen) return null;

  const handleOverlayClick = () => {
    onClose();
  };

  const handleContentClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in-fast"
      onClick={handleOverlayClick}
    >
      <div
        className="relative w-full max-w-6xl h-[90vh] mx-4 bg-white dark:bg-[#212121] rounded-xl shadow-2xl flex flex-col overflow-hidden animate-modal-in"
        onClick={handleContentClick}
      >
        {/* Header */}
        <div className="flex-shrink-0 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1a1a1a] px-4 md:px-6 py-3 md:py-4">
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0 mr-4">
              <h2 className="text-lg md:text-xl font-semibold text-gray-900 dark:text-white truncate">
                {title}
              </h2>
              {subtitle && (
                <p className="hidden sm:block text-sm text-gray-600 dark:text-gray-400">
                  {subtitle}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="flex-shrink-0 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              <IconX size={20} />
            </button>
          </div>

          {/* Mobile Panel Toggle */}
          <div className="md:hidden mt-3 flex gap-2">
            <button
              onClick={() => setMobileActivePanel('form')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                mobileActivePanel === 'form'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
              }`}
            >
              <IconEdit size={16} />
              Form
            </button>
            <button
              onClick={() => setMobileActivePanel('ai')}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                mobileActivePanel === 'ai'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
              }`}
            >
              <IconSparkles size={16} />
              AI Assist
            </button>
          </div>
        </div>

        {/* Content Area - Two Panel Layout */}
        <div className="flex-1 overflow-hidden flex">
          {/* Left Panel - Form */}
          <div
            className={`flex-1 flex flex-col overflow-hidden md:border-r border-gray-200 dark:border-gray-700 ${
              mobileActivePanel === 'ai' ? 'hidden md:flex' : 'flex'
            }`}
          >
            <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-6">
              {leftPanel}
            </div>
          </div>

          {/* Right Panel - AI Assist */}
          <div
            className={`${
              mobileActivePanel === 'form' ? 'hidden md:block' : 'block'
            } w-full md:w-auto overflow-y-auto`}
          >
            {rightPanel}
          </div>
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex-shrink-0 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1a1a1a] px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

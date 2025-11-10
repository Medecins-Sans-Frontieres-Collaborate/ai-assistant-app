import { IconX } from '@tabler/icons-react';
import React, {
  ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import { useTranslations } from 'next-intl';

import useModal from '@/client/hooks/ui/useModal';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string | ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  preventOutsideClick?: boolean;
  preventEscapeKey?: boolean;
  showCloseButton?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  icon?: ReactNode;
  footer?: ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  headerClassName?: string;
  betaBadge?: ReactNode;
  closeWithButton?: boolean;
  verticalAlign?: 'center' | 'top';
}

/**
 * A standardized modal component that handles:
 * - Backdrop overlay
 * - Modal content positioning
 * - Close button
 * - Outside click handling
 * - Escape key handling
 * - Focus trapping
 * - Customizable header with optional icon and beta badge
 * - Optional footer section
 * - Different size options
 * - Loading overlay capability
 */
const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  className = '',
  contentClassName = '',
  preventOutsideClick = false,
  preventEscapeKey = false,
  showCloseButton = true,
  size = 'md',
  icon,
  footer,
  initialFocusRef,
  headerClassName = '',
  betaBadge,
  closeWithButton = true,
  verticalAlign = 'center',
}) => {
  const t = useTranslations();
  const [mounted, setMounted] = useState(false);
  const modalContentRef = useModal(
    isOpen,
    onClose,
    preventOutsideClick,
    preventEscapeKey,
  );

  // Track if component is mounted to avoid SSR hydration issues
  // This is a valid use case for setting state in an effect - we need to detect client-side mounting
  // before rendering the portal to prevent SSR hydration mismatches
  useLayoutEffect(() => {
    setMounted(true); // eslint-disable-line
  }, []);

  // Set focus on the specified element when the modal opens
  useEffect(() => {
    if (isOpen && initialFocusRef?.current) {
      initialFocusRef.current.focus();
    }
  }, [isOpen, initialFocusRef]);

  // Calculate size classes
  const sizeClasses = useMemo(
    () =>
      ({
        sm: 'max-w-sm',
        md: 'max-w-lg',
        lg: 'max-w-2xl',
        xl: 'max-w-4xl',
        full: 'max-w-full mx-4',
      })[size],
    [size],
  );

  if (!isOpen) return null;

  // Check if header should be shown
  const showHeader = title || icon;
  // Only show divider if there's actually content in the header
  const showDivider = showHeader && title;

  // Extract z-index from className if provided
  const zIndexClass = className.match(/(!?z-\[?\d+\]?)/)?.[0] || 'z-50';

  const modalContent = (
    <div
      className={`fixed inset-0 ${zIndexClass} flex ${verticalAlign === 'top' ? 'items-start pt-16' : 'items-center'} justify-center overflow-y-auto`}
    >
      {/* Backdrop/overlay */}
      <div
        className="fixed inset-0 bg-black bg-opacity-40 backdrop-blur-sm animate-fade-in-fast"
        onClick={!preventOutsideClick ? onClose : undefined}
        aria-hidden="true"
      />

      {/* Modal container */}
      <div
        ref={modalContentRef}
        className={`${sizeClasses} w-full bg-white dark:bg-[#171717] rounded-lg shadow-lg p-6 relative z-10 animate-modal-in ${className.replace(/!?z-\[?\d+\]?/, '')}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'modal-title' : undefined}
      >
        {/* Beta badge positioning */}
        {betaBadge && (
          <div className="absolute -top-4 -left-4">{betaBadge}</div>
        )}

        {/* Close button - standalone if not in header */}
        {showCloseButton && !showHeader && (
          <button
            onClick={onClose}
            className={`text-gray-600 dark:text-neutral-300 hover:text-gray-900 dark:hover:text-white transition-colors ${
              closeWithButton
                ? 'absolute -top-4 -right-4 p-1 bg-gray-200 dark:bg-neutral-700 rounded-full'
                : 'absolute top-4 right-4'
            }`}
            aria-label={t('common.closeModal')}
          >
            {closeWithButton ? (
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
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            ) : (
              <IconX size={24} />
            )}
          </button>
        )}

        {/* Header with title and close button - only if title or icon exists */}
        {showHeader && (
          <div
            className={`flex justify-between items-center ${showDivider ? 'border-b dark:border-neutral-700 pb-3 mb-4' : 'mb-4'} ${headerClassName}`}
          >
            <div className="flex items-center">
              {icon && <div className="mr-2">{icon}</div>}
              {title &&
                (typeof title === 'string' ? (
                  <h3
                    id="modal-title"
                    className="text-xl font-semibold text-gray-800 dark:text-white"
                  >
                    {title}
                  </h3>
                ) : (
                  <div id="modal-title">{title}</div>
                ))}
            </div>

            {showCloseButton && (
              <button
                onClick={onClose}
                className={`text-gray-600 dark:text-neutral-300 hover:text-gray-900 dark:hover:text-white transition-colors ${closeWithButton ? 'absolute -top-4 -right-4 p-1 bg-gray-200 dark:bg-neutral-700 rounded-full' : ''}`}
                aria-label={t('common.closeModal')}
              >
                {closeWithButton ? (
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
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                ) : (
                  <IconX size={24} />
                )}
              </button>
            )}
          </div>
        )}

        {/* Modal content */}
        <div className={`modal-content ${contentClassName}`}>{children}</div>

        {/* Footer if provided */}
        {footer && (
          <div className="mt-6 pt-4 border-t border-gray-200 dark:border-neutral-700">
            {footer}
          </div>
        )}
      </div>
    </div>
  );

  // Use portal to render modal at document root to avoid z-index stacking issues
  // Wait for client-side mount to prevent SSR hydration mismatch
  if (!mounted) {
    return null;
  }

  return createPortal(modalContent, document.body);
};

export default Modal;

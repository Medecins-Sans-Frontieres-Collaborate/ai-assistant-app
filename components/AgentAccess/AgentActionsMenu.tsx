'use client';

import { IconDots } from '@tabler/icons-react';
import {
  FC,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import { DropdownPortal } from '@/components/UI/DropdownPortal';

interface AgentActionsMenuProps {
  name: string;
  children: ReactNode;
}

/**
 * Secondary row actions in the shared viewport-aware portal. Supports arrow
 * navigation, Home/End, Escape and Tab, and restores focus to the trigger.
 * Existing action components retain their own disabled and confirmation logic.
 */
export const AgentActionsMenu: FC<AgentActionsMenuProps> = ({
  name,
  children,
}) => {
  const t = useTranslations('announcements');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const returnFocus = () => {
    close();
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const buttons =
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.forEach((button) => {
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
    });
    menuRef.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus();
  }, [open]);

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${t('more')}: ${name}`}
        title={t('more')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="flex min-w-9 items-center justify-center rounded-md border border-gray-200 p-2 text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        <IconDots aria-hidden="true" size={18} />
      </button>
      <DropdownPortal
        triggerRef={triggerRef}
        isOpen={open}
        onClose={close}
        align="right"
      >
        <div
          ref={menuRef}
          id={id}
          role="menu"
          aria-label={`${t('more')}: ${name}`}
          onClick={(event) => {
            const button = (event.target as HTMLElement).closest('button');
            if (button && !button.disabled) returnFocus();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Tab') {
              event.preventDefault();
              returnFocus();
              return;
            }
            const items = Array.from(
              menuRef.current?.querySelectorAll<HTMLButtonElement>(
                'button:not(:disabled)',
              ) ?? [],
            );
            if (!items.length) return;
            const current = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === 'ArrowDown'
                ? (current + 1) % items.length
                : event.key === 'ArrowUp'
                  ? (current - 1 + items.length) % items.length
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : -1;
            if (next >= 0) {
              event.preventDefault();
              items[next].focus();
            }
          }}
          className="flex w-56 max-w-[calc(100vw-1rem)] flex-col gap-0.5 rounded-lg border border-gray-200 bg-gray-50 p-1 shadow-lg dark:border-gray-700 dark:bg-gray-800 [&_button]:min-h-11 [&_button]:w-full [&_button]:justify-start [&_button]:rounded-md [&_button]:border-0 [&_button]:px-3 [&_button]:py-2 [&_button]:text-start [&_button]:focus-visible:outline [&_button]:focus-visible:outline-2"
        >
          {children}
        </div>
      </DropdownPortal>
    </div>
  );
};

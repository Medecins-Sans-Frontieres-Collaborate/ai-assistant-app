'use client';

import {
  IconClipboardText,
  IconFileText,
  IconLink,
  IconMarkdown,
  IconPhoto,
} from '@tabler/icons-react';
import {
  FC,
  KeyboardEvent,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useRef,
} from 'react';

import { useTranslations } from 'next-intl';

import {
  PasteOption,
  PasteOptionId,
  PasteOptionSection,
} from '@/client/services/paste/pasteOptions';

import { DropdownPortal } from '@/components/UI/DropdownPortal';

interface PasteOptionsMenuProps {
  /** Null closes the menu. */
  options: PasteOption[] | null;
  /** The composer; the menu anchors to it and hands focus back on close. */
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onSelect: (id: PasteOptionId) => void;
  onDismiss: () => void;
}

const SECTION_ORDER: PasteOptionSection[] = ['insert', 'attach'];

const ICONS: Record<PasteOptionId, ReactNode> = {
  text: <IconClipboardText size={16} />,
  markdown: <IconMarkdown size={16} />,
  attachText: <IconFileText size={16} />,
  attachMarkdown: <IconMarkdown size={16} />,
  image: <IconPhoto size={16} />,
  link: <IconLink size={16} />,
};

/**
 * The "paste as…" chooser opened by Ctrl/Cmd+Shift+V. Lists only the
 * representations the clipboard actually holds, grouped into what goes into
 * the message and what becomes an attachment.
 *
 * Keyboard: focus lands on the first item when the menu opens; Up/Down wrap,
 * Home/End jump, Enter/Space choose, Escape cancels, and the digits 1–9 pick
 * an item directly (the number is shown next to each label). Focus returns
 * to the composer when the menu closes, whichever way it closed.
 */
export const PasteOptionsMenu: FC<PasteOptionsMenuProps> = ({
  options,
  textareaRef,
  onSelect,
  onDismiss,
}) => {
  const t = useTranslations('pastedText.options');
  const menuRef = useRef<HTMLDivElement>(null);
  const isOpen = options !== null && options.length > 0;

  // Move focus into the menu on open and back to the composer on close.
  useEffect(() => {
    if (!isOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]',
    );
    first?.focus();
    const textarea = textareaRef.current;
    return () => {
      textarea?.focus();
    };
  }, [isOpen, textareaRef]);

  const items = useCallback(
    () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>(
          'button[role="menuitem"]',
        ) ?? [],
      ),
    [],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = items();
    if (buttons.length === 0) return;
    const current = buttons.findIndex((b) => b === document.activeElement);

    const focusAt = (index: number) => {
      const wrapped = (index + buttons.length) % buttons.length;
      buttons[wrapped].focus();
    };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAt(current + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(current - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        return;
      case 'End':
        event.preventDefault();
        focusAt(buttons.length - 1);
        return;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      case 'Tab':
        // The menu is modal to the keyboard: tabbing out would strand focus
        // behind an open chooser.
        event.preventDefault();
        focusAt(event.shiftKey ? current - 1 : current + 1);
        return;
      default:
        break;
    }

    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (index < buttons.length) {
        event.preventDefault();
        buttons[index].click();
      }
    }
  };

  if (!isOpen) return null;

  // Accelerator digits run across sections, matching the visual order —
  // which is the order of `options` itself, since sections are contiguous.
  const acceleratorOf = (option: PasteOption) => options.indexOf(option) + 1;

  return (
    <DropdownPortal
      triggerRef={textareaRef}
      isOpen={isOpen}
      onClose={onDismiss}
      align="left"
    >
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('menuLabel')}
        onKeyDown={handleKeyDown}
        className="w-72 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg overflow-hidden"
      >
        <div className="px-3 pt-2 pb-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {t('menuLabel')}
        </div>
        {SECTION_ORDER.map((section) => {
          const sectionOptions = options.filter((o) => o.section === section);
          if (sectionOptions.length === 0) return null;
          return (
            <div key={section} role="group" aria-label={t(`${section}Heading`)}>
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {t(`${section}Heading`)}
              </div>
              {sectionOptions.map((option) => {
                const accelerator = acceleratorOf(option);
                const label =
                  option.id === 'image'
                    ? t('image', { count: option.count ?? 1 })
                    : t(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    data-paste-option={option.id}
                    onClick={() => onSelect(option.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-900 dark:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-700 focus:bg-neutral-100 dark:focus:bg-neutral-700 focus:outline-none transition-colors"
                  >
                    <span className="flex-shrink-0 text-neutral-500 dark:text-neutral-400">
                      {ICONS[option.id]}
                    </span>
                    <span className="flex-1">{label}</span>
                    {accelerator <= 9 && (
                      <kbd className="text-[11px] text-neutral-400 dark:text-neutral-500 font-mono">
                        {accelerator}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
        <div className="border-t border-neutral-200 dark:border-neutral-700 px-3 py-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
          {t('hint')}
        </div>
      </div>
    </DropdownPortal>
  );
};

'use client';

import { IconArrowUp, IconX } from '@tabler/icons-react';
import {
  FormEvent,
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useTranslations } from 'next-intl';

import {
  ChangeSelection,
  MAX_CHANGE_INSTRUCTION_CHARS,
  locateSelection,
} from '@/lib/utils/shared/translation/changeRequest';

/** Gap between the highlighted text and the popover, in pixels. */
const POPOVER_GAP_PX = 6;
/** Room the popover needs above the highlight before it flips below. */
const POPOVER_HEIGHT_PX = 84;
const POPOVER_WIDTH_PX = 300;

interface PickedSelection {
  selection: ChangeSelection;
  /** Popover position, relative to the wrapper. */
  top: number;
  left: number;
  /** True when the popover sits above the highlight. */
  above: boolean;
}

interface SelectionChangeRequestProps {
  /** The translation the children render. */
  text: string;
  /** True while a request cannot be made; no popover is offered. */
  disabled?: boolean;
  onSubmit: (instruction: string, selection: ChangeSelection) => void;
  /** The rendered translation. */
  children: ReactNode;
}

/**
 * Lets the user highlight a passage of the translation and ask for a change
 * to just that passage. Highlighting shows a small popover beside the
 * selection; the field is not focused until clicked, so highlighting to copy
 * works as before.
 */
export function SelectionChangeRequest({
  text,
  disabled,
  onSubmit,
  children,
}: SelectionChangeRequestProps) {
  const t = useTranslations('workflows');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLFormElement>(null);
  const [picked, setPicked] = useState<PickedSelection | null>(null);
  const [draft, setDraft] = useState('');

  const close = useCallback(() => {
    setPicked(null);
    setDraft('');
  }, []);

  /** Reads the browser's selection and offers the popover for it. */
  const readSelection = useCallback(() => {
    const wrapper = wrapperRef.current;
    const textElement = textRef.current;
    const selection = window.getSelection();
    if (!wrapper || !textElement || !selection) return;
    if (
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !textElement.contains(selection.anchorNode) ||
      !textElement.contains(selection.focusNode)
    ) {
      close();
      return;
    }
    const range = selection.getRangeAt(0);
    // Characters between the start of the translation and the highlight.
    const lead = document.createRange();
    lead.selectNodeContents(textElement);
    lead.setEnd(range.startContainer, range.startOffset);
    const located = locateSelection(
      text,
      selection.toString(),
      lead.toString().length,
    );
    if (!located) {
      close();
      return;
    }
    // Not every environment measures ranges; the corner is a safe fallback.
    const box =
      typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : wrapper.getBoundingClientRect();
    const frame = wrapper.getBoundingClientRect();
    const above = box.top - frame.top >= POPOVER_HEIGHT_PX;
    setPicked({
      selection: located,
      above,
      top: above
        ? box.top - frame.top - POPOVER_GAP_PX
        : box.bottom - frame.top + POPOVER_GAP_PX,
      left: Math.max(
        0,
        Math.min(box.left - frame.left, frame.width - POPOVER_WIDTH_PX),
      ),
    });
  }, [text, close]);

  // A click anywhere else, or a changed or disabled text, withdraws the offer.
  useEffect(() => {
    if (!picked) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [picked, close]);
  const stale =
    picked !== null &&
    (disabled ||
      !text.startsWith(picked.selection.text, picked.selection.start));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const instruction = draft.trim();
    if (!picked || !instruction) return;
    onSubmit(instruction, picked.selection);
    window.getSelection()?.removeAllRanges();
    close();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  };
  /** Selection changes inside the popover's own field are not highlights. */
  const fromPopover = (target: EventTarget) =>
    popoverRef.current?.contains(target as Node) ?? false;

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseUp={(event) => {
        if (!disabled && !fromPopover(event.target)) readSelection();
      }}
      onKeyUp={(event) => {
        if (!disabled && !fromPopover(event.target)) readSelection();
      }}
    >
      <div ref={textRef}>{children}</div>
      {picked && !stale && (
        <form
          ref={popoverRef}
          onSubmit={submit}
          onKeyDown={onKeyDown}
          style={{
            top: picked.top,
            left: picked.left,
            width: POPOVER_WIDTH_PX,
            transform: picked.above ? 'translateY(-100%)' : undefined,
          }}
          className="absolute z-20 max-w-full whitespace-normal rounded-lg border border-gray-300 bg-white p-2 shadow-lg dark:border-gray-600 dark:bg-surface-dark-elevated"
        >
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={MAX_CHANGE_INSTRUCTION_CHARS}
              autoComplete="off"
              aria-label={t('translation.changeSelectionLabel')}
              placeholder={t('translation.changeSelectionPlaceholder')}
              className="min-h-[32px] min-w-0 flex-1 rounded-md border border-gray-300 bg-gray-50 px-2 text-sm text-gray-900 placeholder-gray-500 focus:border-blue-600 focus:outline-none dark:border-gray-700 dark:bg-surface-dark dark:text-gray-100 dark:placeholder-gray-400"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label={t('translation.changeSend')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-300 text-gray-900 hover:bg-gray-400 disabled:pointer-events-none disabled:opacity-30 dark:bg-surface-dark dark:text-white dark:hover:bg-gray-700"
            >
              <IconArrowUp size={16} aria-hidden />
            </button>
            <button
              type="button"
              onClick={close}
              aria-label={t('translation.changeSelectionClose')}
              className="flex h-8 w-6 shrink-0 items-center justify-center rounded text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-surface-dark"
            >
              <IconX size={14} aria-hidden />
            </button>
          </div>
          <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400">
            {t('translation.changeSelectionScope')}
          </p>
        </form>
      )}
    </div>
  );
}

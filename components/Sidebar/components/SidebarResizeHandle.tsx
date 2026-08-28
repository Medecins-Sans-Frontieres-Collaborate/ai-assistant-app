'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslations } from 'next-intl';

import { useUI } from '@/client/hooks/ui/useUI';

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
} from '@/types/ui';

/** Arrow-key step for the keyboard path. */
const KEYBOARD_STEP_PX = 16;

/**
 * Drag handle on the sidebar's right edge (desktop, expanded state only).
 *
 * Pointer drags write the live width straight to the `--sidebar-width`
 * custom property on the shell wrapper (`[data-sidebar-width-root]`) so the
 * layout follows the pointer without a React re-render (and cookie write)
 * per move; the width is committed to preferences once on release. While
 * dragging, `data-sidebar-resizing` on <html> suspends the width/margin
 * transitions the collapse toggle otherwise uses (see globals.css).
 *
 * Keyboard: the handle is a focusable `separator`; ←/→ nudge by 16px, Home
 * resets to the default. Double-click also resets.
 */
export function SidebarResizeHandle() {
  const t = useTranslations();
  const { sidebarWidth, setSidebarWidth } = useUI();
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number;
    startWidth: number;
    latest: number;
    root: HTMLElement | null;
  } | null>(null);
  // Mirrors the live width for aria-valuenow while dragging.
  const [liveWidth, setLiveWidth] = useState<number | null>(null);

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    document.documentElement.removeAttribute('data-sidebar-resizing');
    setLiveWidth(null);
    // React owns the inline custom property; committing the preference makes
    // the next render write the same value we set imperatively, so the DOM
    // and the state agree either way.
    setSidebarWidth(drag.latest);
  }, [setSidebarWidth]);

  // Safety net: a pointer released outside the window (or capture lost)
  // must not leave the document in resizing mode.
  useEffect(() => {
    const onUp = () => finishDrag();
    window.addEventListener('pointerup', onUp);
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('blur', onUp);
    };
  }, [finishDrag]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const root =
      handleRef.current?.closest<HTMLElement>('[data-sidebar-width-root]') ??
      null;
    dragRef.current = {
      startX: e.clientX,
      startWidth: sidebarWidth,
      latest: sidebarWidth,
      root,
    };
    document.documentElement.setAttribute('data-sidebar-resizing', '');
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // jsdom / old browsers: window-level pointerup still ends the drag.
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clampSidebarWidth(drag.startWidth + (e.clientX - drag.startX));
    if (next === drag.latest) return;
    drag.latest = next;
    drag.root?.style.setProperty('--sidebar-width', `${next}px`);
    setLiveWidth(next);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowLeft':
        e.preventDefault();
        setSidebarWidth(sidebarWidth - KEYBOARD_STEP_PX);
        break;
      case 'ArrowRight':
        e.preventDefault();
        setSidebarWidth(sidebarWidth + KEYBOARD_STEP_PX);
        break;
      case 'Home':
        e.preventDefault();
        setSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
        break;
    }
  };

  const shownWidth = liveWidth ?? sidebarWidth;

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resizeHandle')}
      aria-valuenow={shownWidth}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      title={t('sidebar.resizeHint')}
      data-testid="sidebar-resize-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={onKeyDown}
      // Hidden until hover/focus so the default look is unchanged; the 6px
      // hit area straddles the border.
      className="absolute inset-y-0 -right-[3px] z-10 hidden w-1.5 cursor-col-resize transition-colors hover:bg-blue-500/50 focus:bg-blue-500/50 focus:outline-none md:block"
    />
  );
}

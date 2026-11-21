/**
 * Where a key press belongs, for screens that add their own keys on top of
 * the browser's and the app's global ones (lib/constants/keyboardShortcuts).
 */

/** Input types a person types text into; others (checkbox, range) are not. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
]);

/**
 * Whether `target` is where a person types text: a key there belongs to the
 * text (Ctrl+Z undoes typing, arrows move the caret), not to the screen.
 *
 * @param target - The event's target.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return (
    target instanceof HTMLInputElement &&
    TEXT_INPUT_TYPES.has(target.type.toLowerCase())
  );
}

/**
 * Whether a screen's keys apply now: the screen is shown, and the keyboard
 * is either inside it or nowhere in particular (on the page body after a
 * click on something that takes no focus). Keys pressed in another part of
 * the app, such as the sidebar, are left alone.
 *
 * @param root - The screen's outermost element.
 */
export function ownsKeyboard(root: HTMLElement | null): boolean {
  if (!root || root.getClientRects().length === 0) return false;
  const active = document.activeElement;
  return !active || active === document.body || root.contains(active);
}

/** How a group's items are laid out, which decides its arrow keys. */
export type GroupOrientation = 'vertical' | 'horizontal' | 'both';

/**
 * Where an arrow, Home or End key moves the focus in a group that is one
 * Tab stop (a list of pages, the blocks of a page). Arrows stop at the
 * ends rather than wrap: a person moving through a document expects its
 * end to be an end.
 *
 * @param key - The event's `key`.
 * @param index - The item that has focus.
 * @param count - Items in the group.
 * @param orientation - Which arrows move: up/down, left/right, or all four.
 * @param rtl - Right to left: left and right swap.
 * @returns The item to focus, or null when the key does not move the focus.
 */
export function groupKeyTarget(
  key: string,
  index: number,
  count: number,
  orientation: GroupOrientation,
  rtl = false,
): number | null {
  if (count === 0) return null;
  const vertical = orientation !== 'horizontal';
  const horizontal = orientation !== 'vertical';
  const forwardKey = rtl ? 'ArrowLeft' : 'ArrowRight';
  const backKey = rtl ? 'ArrowRight' : 'ArrowLeft';
  let step = 0;
  if ((vertical && key === 'ArrowDown') || (horizontal && key === forwardKey)) {
    step = 1;
  } else if (
    (vertical && key === 'ArrowUp') ||
    (horizontal && key === backKey)
  ) {
    step = -1;
  } else if (key === 'Home') {
    return 0;
  } else if (key === 'End') {
    return count - 1;
  } else {
    return null;
  }
  return Math.min(count - 1, Math.max(0, index + step));
}

import { render } from '@testing-library/react';
import { useRef } from 'react';

import { useAutoFocusComposer } from '@/client/hooks/ui/useAutoFocusComposer';
import { usePasteComposer } from '@/client/hooks/ui/usePasteComposer';

import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A composer, a button and a checkbox beside it. `shown` decides whether
 * the composer has boxes on screen; jsdom lays nothing out, so it is set.
 */
function Screen({
  append,
  shown,
}: {
  append: (text: string) => void;
  shown: boolean;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useAutoFocusComposer({ textareaRef, enabled: true, append });
  usePasteComposer({ textareaRef, enabled: true, append });
  return (
    <div>
      <textarea
        ref={(element) => {
          textareaRef.current = element;
          if (element) {
            vi.spyOn(element, 'getClientRects').mockReturnValue(
              (shown
                ? [new DOMRect(0, 0, 100, 20)]
                : []) as unknown as DOMRectList,
            );
          }
        }}
        aria-label="composer"
      />
      <button type="button">Action</button>
      <input type="checkbox" aria-label="Option" />
    </div>
  );
}

/** Dispatches a key on `target` and says whether something prevented it. */
const press = (target: Element, key: string): boolean =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );

/** Dispatches a paste of `text` on `target`. */
function paste(target: Element, text: string): boolean {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
  return target.dispatchEvent(event);
}

describe('useAutoFocusComposer and usePasteComposer', () => {
  let append: ReturnType<typeof vi.fn<(text: string) => void>>;
  beforeEach(() => {
    append = vi.fn<(text: string) => void>();
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends a letter typed on a button to the composer it shows', () => {
    const { getByRole, getByLabelText } = render(
      <Screen append={append} shown />,
    );
    const action = getByRole('button', { name: 'Action' });
    action.focus();
    expect(press(action, 'x')).toBe(false);
    expect(append).toHaveBeenCalledWith('x');
    expect(document.activeElement).toBe(getByLabelText('composer'));
  });

  it('leaves Space to the button or checkbox it activates', () => {
    const { getByRole } = render(<Screen append={append} shown />);
    const action = getByRole('button', { name: 'Action' });
    action.focus();
    expect(press(action, ' ')).toBe(true);
    const option = getByRole('checkbox', { name: 'Option' });
    expect(press(option, ' ')).toBe(true);
    expect(append).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(action);
  });

  it('still sends Space typed with nothing focused', () => {
    render(<Screen append={append} shown />);
    expect(press(document.body, ' ')).toBe(false);
    expect(append).toHaveBeenCalledWith(' ');
  });

  it('sends nothing to a composer that is not on screen', () => {
    const { getByRole } = render(<Screen append={append} shown={false} />);
    const action = getByRole('button', { name: 'Action' });
    action.focus();
    expect(press(action, 'x')).toBe(true);
    expect(paste(action, 'pasted words')).toBe(true);
    expect(append).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(action);
  });

  it('sends a paste on a button to the composer it shows', () => {
    const { getByRole } = render(<Screen append={append} shown />);
    expect(paste(getByRole('button', { name: 'Action' }), 'pasted words')).toBe(
      false,
    );
    expect(append).toHaveBeenCalledWith('pasted words');
  });
});

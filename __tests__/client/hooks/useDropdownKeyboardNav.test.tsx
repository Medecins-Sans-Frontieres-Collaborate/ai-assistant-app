import { act, renderHook } from '@testing-library/react';

import { useDropdownKeyboardNav } from '@/client/hooks/ui/useDropdownKeyboardNav';
import type { KeyboardNavItem } from '@/client/hooks/ui/useDropdownKeyboardNav';

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('useDropdownKeyboardNav', () => {
  const mockItem1 = { id: '1', onClick: vi.fn() };
  const mockItem2 = { id: '2', onClick: vi.fn() };
  const mockItem3 = { id: '3', onClick: vi.fn() };
  const mockItems: KeyboardNavItem[] = [mockItem1, mockItem2, mockItem3];

  let mockSetSelectedIndex: ReturnType<typeof vi.fn>;
  let mockCloseDropdown: ReturnType<typeof vi.fn>;
  let mockOnCloseModals: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSelectedIndex = vi.fn();
    mockCloseDropdown = vi.fn();
    mockOnCloseModals = vi.fn();
  });

  describe('Initial State', () => {
    it('returns handleKeyDown function', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      expect(typeof result.current.handleKeyDown).toBe('function');
    });
  });

  describe('Arrow Navigation', () => {
    it('moves down with ArrowDown', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockSetSelectedIndex).toHaveBeenCalled();

      // Call the updater function with prevIndex = 0
      const updater = mockSetSelectedIndex.mock.calls[0][0];
      expect(updater(0)).toBe(1);
    });

    it('wraps to first item when ArrowDown at last item', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 2,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      const updater = mockSetSelectedIndex.mock.calls[0][0];
      expect(updater(2)).toBe(0);
    });

    it('moves up with ArrowUp', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 1,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();

      const updater = mockSetSelectedIndex.mock.calls[0][0];
      expect(updater(1)).toBe(0);
    });

    it('wraps to last item when ArrowUp at first item', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      const updater = mockSetSelectedIndex.mock.calls[0][0];
      expect(updater(0)).toBe(2);
    });

    it('cycles through all items with ArrowDown', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as any;

      // Index 0 -> 1
      act(() => {
        result.current.handleKeyDown(event);
      });
      let updater = mockSetSelectedIndex.mock.calls[0][0];
      expect(updater(0)).toBe(1);

      // Index 1 -> 2
      act(() => {
        result.current.handleKeyDown(event);
      });
      updater = mockSetSelectedIndex.mock.calls[1][0];
      expect(updater(1)).toBe(2);

      // Index 2 -> 0 (wrap)
      act(() => {
        result.current.handleKeyDown(event);
      });
      updater = mockSetSelectedIndex.mock.calls[2][0];
      expect(updater(2)).toBe(0);
    });

    it('cycles through all items with ArrowUp', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 2,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
      } as any;

      // Index 2 -> 1
      act(() => {
        result.current.handleKeyDown(event);
      });
      let updater = mockSetSelectedIndex.mock.calls[0][0];
      expect(updater(2)).toBe(1);

      // Index 1 -> 0
      act(() => {
        result.current.handleKeyDown(event);
      });
      updater = mockSetSelectedIndex.mock.calls[1][0];
      expect(updater(1)).toBe(0);

      // Index 0 -> 2 (wrap)
      act(() => {
        result.current.handleKeyDown(event);
      });
      updater = mockSetSelectedIndex.mock.calls[2][0];
      expect(updater(0)).toBe(2);
    });
  });

  describe('Enter Key', () => {
    it('executes onClick of selected item', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 1,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'Enter',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockItem2.onClick).toHaveBeenCalledTimes(1);
      expect(mockItem1.onClick).not.toHaveBeenCalled();
      expect(mockItem3.onClick).not.toHaveBeenCalled();
    });

    it('executes onClick of first item when selectedIndex is 0', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'Enter',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(mockItem1.onClick).toHaveBeenCalledTimes(1);
    });

    it('executes onClick of last item', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 2,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'Enter',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(mockItem3.onClick).toHaveBeenCalledTimes(1);
    });

    it('does nothing when selectedIndex is out of bounds', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 10,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'Enter',
        preventDefault: vi.fn(),
      } as any;

      expect(() => {
        act(() => {
          result.current.handleKeyDown(event);
        });
      }).not.toThrow();

      expect(mockItem1.onClick).not.toHaveBeenCalled();
      expect(mockItem2.onClick).not.toHaveBeenCalled();
      expect(mockItem3.onClick).not.toHaveBeenCalled();
    });
  });

  describe('Escape Key', () => {
    it('closes dropdown', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'Escape',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).toHaveBeenCalled();
      expect(mockCloseDropdown).toHaveBeenCalledTimes(1);
    });

    it('calls onCloseModals when provided', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
          onCloseModals: mockOnCloseModals,
        }),
      );

      const event = {
        key: 'Escape',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(mockCloseDropdown).toHaveBeenCalledTimes(1);
      expect(mockOnCloseModals).toHaveBeenCalledTimes(1);
    });

    it('does not crash when onCloseModals is not provided', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'Escape',
        preventDefault: vi.fn(),
      } as any;

      expect(() => {
        act(() => {
          result.current.handleKeyDown(event);
        });
      }).not.toThrow();

      expect(mockCloseDropdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('isOpen Flag', () => {
    it('does nothing when isOpen is false', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: false,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const arrowEvent = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(arrowEvent);
      });

      expect(arrowEvent.preventDefault).not.toHaveBeenCalled();
      expect(mockSetSelectedIndex).not.toHaveBeenCalled();

      const enterEvent = {
        key: 'Enter',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(enterEvent);
      });

      expect(enterEvent.preventDefault).not.toHaveBeenCalled();
      expect(mockItem1.onClick).not.toHaveBeenCalled();
    });

    it('handles toggling isOpen state', () => {
      let isOpen = false;

      const { result, rerender } = renderHook(
        ({ open }) =>
          useDropdownKeyboardNav({
            isOpen: open,
            items: mockItems,
            selectedIndex: 0,
            setSelectedIndex: mockSetSelectedIndex,
            closeDropdown: mockCloseDropdown,
          }),
        { initialProps: { open: isOpen } },
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as any;

      // When closed, does nothing
      act(() => {
        result.current.handleKeyDown(event);
      });
      expect(mockSetSelectedIndex).not.toHaveBeenCalled();

      // Open dropdown
      isOpen = true;
      rerender({ open: isOpen });

      // When open, responds to events
      act(() => {
        result.current.handleKeyDown(event);
      });
      expect(mockSetSelectedIndex).toHaveBeenCalled();
    });
  });

  describe('Empty Items', () => {
    it('handles empty items array', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: [],
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'Enter',
        preventDefault: vi.fn(),
      } as any;

      expect(() => {
        act(() => {
          result.current.handleKeyDown(event);
        });
      }).not.toThrow();
    });

    it('handles ArrowDown with empty items', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: [],
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(mockSetSelectedIndex).toHaveBeenCalled();
      const updater = mockSetSelectedIndex.mock.calls[0][0];
      // With 0 items: prevIndex < 0 - 1 is always true, so should wrap to 0
      expect(updater(0)).toBe(0);
    });
  });

  describe('Other Keys', () => {
    it('ignores other keys', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'a',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(mockSetSelectedIndex).not.toHaveBeenCalled();
      expect(mockCloseDropdown).not.toHaveBeenCalled();
    });

    it('ignores Space key', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: ' ',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('ignores Tab key', () => {
      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const event = {
        key: 'Tab',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(event);
      });

      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('Callback Stability', () => {
    it('handleKeyDown is stable across rerenders with same dependencies', () => {
      const { result, rerender } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: mockItems,
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      const firstHandler = result.current.handleKeyDown;
      rerender();
      const secondHandler = result.current.handleKeyDown;

      expect(firstHandler).toBe(secondHandler);
    });

    it('handleKeyDown updates when dependencies change', () => {
      const { result, rerender } = renderHook(
        ({ index }) =>
          useDropdownKeyboardNav({
            isOpen: true,
            items: mockItems,
            selectedIndex: index,
            setSelectedIndex: mockSetSelectedIndex,
            closeDropdown: mockCloseDropdown,
          }),
        { initialProps: { index: 0 } },
      );

      const firstHandler = result.current.handleKeyDown;

      rerender({ index: 1 });

      const secondHandler = result.current.handleKeyDown;

      expect(firstHandler).not.toBe(secondHandler);
    });
  });

  describe('Single Item', () => {
    it('handles single item array', () => {
      const singleItem = { id: '1', onClick: vi.fn() };

      const { result } = renderHook(() =>
        useDropdownKeyboardNav({
          isOpen: true,
          items: [singleItem],
          selectedIndex: 0,
          setSelectedIndex: mockSetSelectedIndex,
          closeDropdown: mockCloseDropdown,
        }),
      );

      // ArrowDown wraps to 0
      const downEvent = {
        key: 'ArrowDown',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(downEvent);
      });

      const updater = mockSetSelectedIndex.mock.calls[0][0];
      expect(updater(0)).toBe(0);

      // ArrowUp wraps to 0
      const upEvent = {
        key: 'ArrowUp',
        preventDefault: vi.fn(),
      } as any;

      act(() => {
        result.current.handleKeyDown(upEvent);
      });

      const updater2 = mockSetSelectedIndex.mock.calls[1][0];
      expect(updater2(0)).toBe(0);
    });
  });
});

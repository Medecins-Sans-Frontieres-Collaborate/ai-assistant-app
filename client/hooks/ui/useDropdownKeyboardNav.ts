import { useCallback } from 'react';

export interface KeyboardNavItem {
  id: string;
  onClick: () => void;
}

export interface UseDropdownKeyboardNavParams {
  isOpen: boolean;
  items: KeyboardNavItem[];
  selectedIndex: number;
  setSelectedIndex: (index: number | ((prev: number) => number)) => void;
  closeDropdown: () => void;
  onCloseModals?: () => void;
}

/**
 * Custom hook for managing keyboard navigation in dropdown menus
 * Handles ArrowUp, ArrowDown, Enter, and Escape keys
 */
export const useDropdownKeyboardNav = ({
  isOpen,
  items,
  selectedIndex,
  setSelectedIndex,
  closeDropdown,
  onCloseModals,
}: UseDropdownKeyboardNavParams) => {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!isOpen) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex((prevIndex) =>
            prevIndex < items.length - 1 ? prevIndex + 1 : 0,
          );
          break;

        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex((prevIndex) =>
            prevIndex > 0 ? prevIndex - 1 : items.length - 1,
          );
          break;

        case 'Enter':
          event.preventDefault();
          if (items[selectedIndex]) {
            items[selectedIndex].onClick();
          }
          break;

        case 'Escape':
          event.preventDefault();
          closeDropdown();
          onCloseModals?.();
          break;
      }
    },
    [
      isOpen,
      items,
      selectedIndex,
      setSelectedIndex,
      closeDropdown,
      onCloseModals,
    ],
  );

  return { handleKeyDown };
};

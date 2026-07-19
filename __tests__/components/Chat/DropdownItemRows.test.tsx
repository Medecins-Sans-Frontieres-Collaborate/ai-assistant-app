import { render, screen } from '@testing-library/react';
import React from 'react';

import { DropdownItemRows } from '@/components/Chat/ChatInput/DropdownItemRows';
import { MenuItem } from '@/components/Chat/ChatInput/DropdownMenuItem';

import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

describe('DropdownItemRows', () => {
  const TestIcon = () => <svg data-testid="test-icon">Icon</svg>;

  const createMenuItem = (
    id: string,
    label: string,
    overrides: Partial<MenuItem> = {},
  ): MenuItem => ({
    id,
    icon: <TestIcon />,
    label,
    onClick: vi.fn(),
    category: 'media',
    ...overrides,
  });

  const parent = createMenuItem('attach', 'Attach files');
  const child = createMenuItem('attach-link', 'Attach a link', {
    parentId: 'attach',
  });

  const renderRows = (
    props: Partial<React.ComponentProps<typeof DropdownItemRows>> = {},
  ) =>
    render(
      <DropdownItemRows
        items={[parent]}
        flattenedItems={[parent, child]}
        selectedIndex={-1}
        pinnedToolIds={[]}
        onTogglePin={vi.fn()}
        childrenByParent={{ attach: [child] }}
        expandedParentIds={[]}
        onToggleParentExpanded={vi.fn()}
        {...props}
      />,
    );

  describe('Nesting', () => {
    it('hides children until the parent is expanded', () => {
      renderRows();

      expect(screen.getByText('Attach files')).toBeInTheDocument();
      expect(screen.queryByText('Attach a link')).not.toBeInTheDocument();
    });

    it('reveals children when the parent is expanded', () => {
      renderRows({ expandedParentIds: ['attach'] });

      expect(screen.getByText('Attach a link')).toBeInTheDocument();
    });

    it('renders no disclosure control for a childless row', () => {
      renderRows({ childrenByParent: {} });

      expect(
        screen.queryByRole('button', { name: 'dropdown.showSources' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('Disclosure control', () => {
    it('toggles expansion without firing the row action', async () => {
      const user = userEvent.setup();
      const onToggleParentExpanded = vi.fn();
      const onClick = vi.fn();

      renderRows({
        items: [{ ...parent, onClick }],
        onToggleParentExpanded,
      });

      await user.click(
        screen.getByRole('button', { name: 'dropdown.showSources' }),
      );

      expect(onToggleParentExpanded).toHaveBeenCalledWith('attach');
      expect(onClick).not.toHaveBeenCalled();
    });

    it('reports expansion state to assistive tech', () => {
      const { rerender } = renderRows();

      expect(
        screen.getByRole('button', { name: 'dropdown.showSources' }),
      ).toHaveAttribute('aria-expanded', 'false');

      rerender(
        <DropdownItemRows
          items={[parent]}
          flattenedItems={[parent, child]}
          selectedIndex={-1}
          pinnedToolIds={[]}
          onTogglePin={vi.fn()}
          childrenByParent={{ attach: [child] }}
          expandedParentIds={['attach']}
          onToggleParentExpanded={vi.fn()}
        />,
      );

      expect(
        screen.getByRole('button', { name: 'dropdown.hideSources' }),
      ).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('Selection', () => {
    it('highlights a nested child by its index in the flattened list', () => {
      renderRows({ expandedParentIds: ['attach'], selectedIndex: 1 });

      expect(
        screen.getByText('Attach a link').closest('button'),
      ).toHaveAttribute('aria-current', 'true');
      expect(
        screen.getByText('Attach files').closest('button'),
      ).not.toHaveAttribute('aria-current');
    });
  });
});

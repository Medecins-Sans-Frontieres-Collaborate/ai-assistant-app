import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { MenuItem } from '@/components/Chat/ChatInput/DropdownMenuItem';
import { DropdownMoreSection } from '@/components/Chat/ChatInput/DropdownMoreSection';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

// Isolate from DropdownMenuItem internals and next-intl by mocking both.
vi.mock('@/components/Chat/ChatInput/DropdownMenuItem', () => ({
  DropdownMenuItem: ({ item, hidden }: any) => (
    <div data-testid={`menu-item-${item.id}`} data-hidden={hidden}>
      {item.label}
    </div>
  ),
  MenuItem: {} as any,
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) =>
    key === 'dropdown.sectionMore' ? 'More' : key,
}));

describe('DropdownMoreSection', () => {
  const item = (id: string, label: string): MenuItem => ({
    id,
    icon: <svg />,
    label,
    onClick: vi.fn(),
    category: 'media',
  });

  const renderSection = (
    props: Partial<React.ComponentProps<typeof DropdownMoreSection>> = {},
  ) => {
    const items = props.items ?? [
      item('camera', 'Camera'),
      item('tone', 'Tone'),
    ];
    return render(
      <DropdownMoreSection
        items={items}
        flattenedItems={items}
        selectedIndex={-1}
        pinnedToolIds={[]}
        onTogglePin={vi.fn()}
        onToggleHidden={vi.fn()}
        expanded={false}
        onToggleExpanded={vi.fn()}
        {...props}
      />,
    );
  };

  it('renders nothing when there are no hidden items', () => {
    const { container } = renderSection({ items: [] });
    expect(container.firstChild).toBeNull();
  });

  it('shows the header with a count but hides items when collapsed', () => {
    renderSection({ expanded: false });

    expect(screen.getByRole('button', { name: /More/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.queryByTestId('menu-item-camera')).not.toBeInTheDocument();
  });

  it('reveals the hidden items when expanded', () => {
    renderSection({ expanded: true });

    expect(screen.getByRole('button', { name: /More/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const camera = screen.getByTestId('menu-item-camera');
    expect(camera).toBeInTheDocument();
    expect(camera).toHaveAttribute('data-hidden', 'true');
    expect(screen.getByTestId('menu-item-tone')).toBeInTheDocument();
  });

  it('toggles expansion when the header is clicked', () => {
    const onToggleExpanded = vi.fn();
    renderSection({ onToggleExpanded });

    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

import { Conversation } from '@/types/chat';

import { ConversationItem } from '@/components/Sidebar/ConversationItem';

import '@testing-library/jest-dom';
import { describe, expect, it, vi } from 'vitest';

const t = (key: string) => key;

const conversation = {
  id: 'conv-1',
  name: 'Budget review',
  messages: [],
  folderId: null,
} as unknown as Conversation;

const folders = [
  { id: 'folder-1', name: 'Work' },
  { id: 'folder-2', name: 'Personal' },
];

function renderItem(overrides: Record<string, unknown> = {}) {
  const handlers = {
    handleSelectConversation: vi.fn(),
    handleDeleteConversation: vi.fn(),
    handleMoveToFolder: vi.fn(),
    handleRenameConversation: vi.fn(),
    handleExportConversation: vi.fn(),
  };
  const view = render(
    <ConversationItem
      conversation={conversation}
      isSelected={false}
      folders={folders}
      t={t}
      {...handlers}
      {...overrides}
    />,
  );
  return { ...view, handlers };
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'Options' }));
}

describe('ConversationItem', () => {
  it('renders the conversation name', () => {
    renderItem();
    expect(screen.getByText('Budget review')).toBeInTheDocument();
  });

  it('selects the conversation on row click', () => {
    const { handlers, container } = renderItem();
    fireEvent.click(container.firstChild as HTMLElement);
    expect(handlers.handleSelectConversation).toHaveBeenCalledWith('conv-1');
  });

  it('renders the options menu in a document.body portal, not inside the row', () => {
    const { container } = renderItem();
    openMenu();

    const portal = document.querySelector('[data-dropdown-portal]');
    expect(portal).toBeInTheDocument();
    // Regression guard: inside a virtualized row (transform => stacking
    // context) an inline menu is overpainted by following rows and its
    // clicks fall through. The menu must escape the row via portal.
    expect(container.contains(portal)).toBe(false);
    expect(portal).toContainElement(screen.getByText('Delete'));
  });

  it('calls delete handler and closes the menu', () => {
    const { handlers } = renderItem();
    openMenu();
    fireEvent.click(screen.getByText('Delete'));

    expect(handlers.handleDeleteConversation).toHaveBeenCalledWith(
      'conv-1',
      expect.anything(),
    );
    expect(document.querySelector('[data-dropdown-portal]')).toBeNull();
  });

  it('does not select the conversation when clicking a menu item', () => {
    const { handlers } = renderItem();
    openMenu();
    fireEvent.click(screen.getByText('Export'));

    expect(handlers.handleExportConversation).toHaveBeenCalled();
    expect(handlers.handleSelectConversation).not.toHaveBeenCalled();
  });

  it('moves the conversation via the folder submenu', () => {
    const { handlers } = renderItem();
    openMenu();
    fireEvent.click(screen.getByText('Move to folder'));
    fireEvent.click(screen.getByText('Work'));

    expect(handlers.handleMoveToFolder).toHaveBeenCalledWith(
      'conv-1',
      'folder-1',
    );
    expect(document.querySelector('[data-dropdown-portal]')).toBeNull();
  });

  it('enters rename mode from the menu', () => {
    renderItem();
    openMenu();
    fireEvent.click(screen.getByText('Rename'));

    const input = screen.getByDisplayValue('Budget review');
    expect(input).toBeInTheDocument();
    expect(document.querySelector('[data-dropdown-portal]')).toBeNull();
  });
});
